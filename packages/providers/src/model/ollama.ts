import {
  fail,
  ok,
  parseStructuredOutput,
  type GenerateStructuredRequest,
  type ModelError,
  type ModelProvider,
  type ProviderDescriptor,
  type ProviderHealth,
  type Result,
  type StructuredResult,
} from "@kalpix/core";
import { DEFAULT_MODEL_TIMEOUT_MS, fetchJson, jsonSchemaOf, type ModelFetch } from "./shared";

export const OLLAMA_DESCRIPTOR: ProviderDescriptor = {
  id: "ollama",
  name: "Ollama (local)",
  category: "model",
  costTier: "free",
  requiredSecrets: [], // OLLAMA_BASE_URL is configuration, not a secret
  commercialUseVerified: false, // each model has its own licence: owner confirms
};

export const OLLAMA_NOTICE =
  "Runs on your own machine: needs enough RAM/GPU for the chosen model (see pnpm doctor). " +
  "No data leaves the machine. Check the licence of each model before commercial use.";

export const DEFAULT_OLLAMA_MODEL = "llama3.2:3b";

/** Local Ollama over HTTP (/api/chat with a JSON-schema `format`). Cost 0. */
export class OllamaModelProvider implements ModelProvider {
  readonly descriptor = OLLAMA_DESCRIPTOR;
  readonly dataUseNotice = OLLAMA_NOTICE;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly fetch: ModelFetch;
  private readonly timeoutMs: number;

  constructor(opts: { baseUrl: string; model?: string; fetch?: ModelFetch; timeoutMs?: number }) {
    const u = new URL(opts.baseUrl); // throws on a bad URL
    if (u.protocol !== "http:" && u.protocol !== "https:")
      throw new Error("OLLAMA_BASE_URL must be http(s)");
    this.baseUrl = u.toString().replace(/\/+$/, "");
    this.model = opts.model?.trim() || DEFAULT_OLLAMA_MODEL;
    this.fetch = opts.fetch ?? ((i, init) => fetch(i, init));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
  }

  async healthCheck(): Promise<ProviderHealth> {
    const r = await fetchJson(this.fetch, `${this.baseUrl}/api/tags`, { method: "GET" }, 5000);
    if (!r.ok) return { status: "error", checkedAt: new Date(), detail: r.error.message };
    const models = ((r.body as { models?: { name?: string }[] }).models ?? []).map((m) => m.name);
    return models.includes(this.model)
      ? { status: "connected", checkedAt: new Date(), detail: this.model }
      : {
          status: "not_configured",
          checkedAt: new Date(),
          detail: `Model ${this.model} not pulled`,
        };
  }

  async generateStructured<T>(
    req: GenerateStructuredRequest<T>,
  ): Promise<Result<StructuredResult<T>, ModelError>> {
    const body = {
      model: this.model,
      stream: false,
      format: jsonSchemaOf(req.schema) ?? "json",
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.prompt },
      ],
      options: {
        temperature: req.temperature ?? 0.2,
        ...(req.maxOutputTokens ? { num_predict: req.maxOutputTokens } : {}),
      },
    };
    const r = await fetchJson(
      this.fetch,
      `${this.baseUrl}/api/chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      this.timeoutMs,
      req.signal,
    );
    if (!r.ok) return fail({ ...r.error, model: this.model });
    const b = r.body as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const usage = {
      inputTokens: b.prompt_eval_count ?? 0,
      outputTokens: b.eval_count ?? 0,
      costMinor: 0, // local hardware
      currency: "INR",
      isEstimate: b.prompt_eval_count === undefined,
    };
    const parsed = parseStructuredOutput(b.message?.content ?? "", req.schema);
    if (!parsed.ok) return fail({ ...parsed.error, usage, model: this.model });
    return ok({
      data: parsed.value,
      provider: this.descriptor.id,
      model: this.model,
      promptVersion: req.promptVersion,
      usage,
      mock: false,
    });
  }
}
