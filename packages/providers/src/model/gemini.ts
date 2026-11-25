import {
  fail,
  ok,
  parseStructuredOutput,
  tokenCostMinor,
  type GenerateStructuredRequest,
  type ModelError,
  type ModelProvider,
  type ProviderDescriptor,
  type ProviderHealth,
  type Result,
  type StructuredResult,
} from "@kalpix/core";
import { DEFAULT_MODEL_TIMEOUT_MS, fetchJson, type ModelFetch } from "./shared";

export const GEMINI_DESCRIPTOR: ProviderDescriptor = {
  id: "gemini",
  name: "Google Gemini API",
  category: "model",
  costTier: "freemium",
  requiredSecrets: ["GEMINI_API_KEY"],
  commercialUseVerified: false,
  fallbackProviderId: "ollama",
};

export const GEMINI_FREE_TIER_NOTICE =
  "Gemini API free tier: Google may use prompts and responses to improve its products, and " +
  "people may review them. Do not send personal or customer-confidential data on the free tier " +
  "(Kalpix masks phone numbers and emails before any AI call). Use a paid (billing-enabled) " +
  "project for customer data. Free-tier rate limits are low and change without notice.";

export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const API = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Gemini generateContent with JSON output (responseMimeType application/json), validated with
 * zod. The key goes in the x-goog-api-key header, never in the URL or an error message.
 * Cost is 0 unless per-million-token rates are configured (no prices live in code).
 */
export class GeminiModelProvider implements ModelProvider {
  readonly descriptor = GEMINI_DESCRIPTOR;
  readonly dataUseNotice = GEMINI_FREE_TIER_NOTICE;
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetch: ModelFetch;
  private readonly timeoutMs: number;
  private readonly rates: { inputPerMillionMinor?: number; outputPerMillionMinor?: number };

  constructor(opts: {
    apiKey: string;
    model?: string;
    fetch?: ModelFetch;
    timeoutMs?: number;
    rates?: { inputPerMillionMinor?: number; outputPerMillionMinor?: number };
  }) {
    if (!opts.apiKey?.trim()) throw new Error("GEMINI_API_KEY is not set");
    this.apiKey = opts.apiKey.trim();
    this.model = opts.model?.trim() || DEFAULT_GEMINI_MODEL;
    if (!/^[a-z0-9][a-z0-9.-]*$/i.test(this.model)) throw new Error("Invalid Gemini model name");
    this.fetch = opts.fetch ?? ((i, init) => fetch(i, init));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
    this.rates = opts.rates ?? {};
  }

  private headers() {
    return { "content-type": "application/json", "x-goog-api-key": this.apiKey };
  }

  /** Strips the key from any text before it is stored or shown. */
  private redact(e: ModelError): ModelError {
    return { ...e, message: e.message.split(this.apiKey).join("[redacted]") };
  }

  async healthCheck(): Promise<ProviderHealth> {
    const r = await fetchJson(
      this.fetch,
      `${API}/models/${this.model}`,
      { method: "GET", headers: this.headers() },
      5000,
    );
    return r.ok
      ? { status: "connected", checkedAt: new Date(), detail: this.model }
      : { status: "error", checkedAt: new Date(), detail: this.redact(r.error).message };
  }

  async generateStructured<T>(
    req: GenerateStructuredRequest<T>,
  ): Promise<Result<StructuredResult<T>, ModelError>> {
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: req.temperature ?? 0.2,
        ...(req.maxOutputTokens ? { maxOutputTokens: req.maxOutputTokens } : {}),
      },
    };
    const r = await fetchJson(
      this.fetch,
      `${API}/models/${this.model}:generateContent`,
      { method: "POST", headers: this.headers(), body: JSON.stringify(body) },
      this.timeoutMs,
      req.signal,
    );
    if (!r.ok) return fail({ ...this.redact(r.error), model: this.model });
    const b = r.body as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const u = {
      inputTokens: b.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: b.usageMetadata?.candidatesTokenCount ?? 0,
    };
    const usage = {
      ...u,
      costMinor: tokenCostMinor(u, this.rates),
      currency: "INR",
      isEstimate: !b.usageMetadata,
    };
    if (b.promptFeedback?.blockReason)
      return fail({
        code: "refused",
        message: `Gemini blocked the prompt: ${b.promptFeedback.blockReason}`,
        usage,
        model: this.model,
      });
    const cand = b.candidates?.[0];
    const text = (cand?.content?.parts ?? []).map((p) => p.text ?? "").join("");
    if (!text)
      return fail({
        code: "malformed_output",
        message: `Gemini returned no text (finishReason ${cand?.finishReason ?? "none"})`,
        usage,
        model: this.model,
      });
    const parsed = parseStructuredOutput(text, req.schema);
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
