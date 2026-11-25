/**
 * Model (LLM) provider contract (Phase 5). Adapters live in @kalpix/providers (MOCK, Ollama,
 * Gemini). Every call asks for structured output validated with a zod schema: free text from a
 * model is never trusted as data. Token and cost accounting comes back with every result,
 * including failed parses (the tokens were still spent).
 */
import type { z } from "zod";
import { fail, ok, type Provider, type Result } from "./provider";

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  /** Cost in currency minor units (paise). 0 for local, free-tier and MOCK calls. */
  costMinor: number;
  currency: string;
  /** True when tokens or cost were estimated rather than reported by the provider. */
  isEstimate: boolean;
}

export const ZERO_USAGE: ModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  costMinor: 0,
  currency: "INR",
  isEstimate: false,
};

export interface GenerateStructuredRequest<T> {
  /** zod schema the output must satisfy. */
  schema: z.ZodType<T>;
  /** Short name of the schema, sent to providers that support named schemas. */
  schemaName: string;
  system: string;
  prompt: string;
  promptVersion: string;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface StructuredResult<T> {
  data: T;
  provider: string;
  model: string;
  promptVersion: string;
  usage: ModelUsage;
  /** True for the MOCK provider: output is fixture text, not a model's judgement. */
  mock: boolean;
}

export type ModelErrorCode =
  | "not_configured"
  | "refused" // gating: production MOCK, missing key ...
  | "http"
  | "timeout"
  | "malformed_output" // not JSON
  | "schema_mismatch"; // JSON, but fails the zod schema

export interface ModelError {
  code: ModelErrorCode;
  message: string;
  /** Tokens spent before the failure, when known. */
  usage?: ModelUsage;
  model?: string;
}

export interface ModelProvider extends Provider {
  readonly model: string;
  /** Free-text notice shown before enabling (e.g. free tier may use data for training). */
  readonly dataUseNotice?: string;
  generateStructured<T>(
    req: GenerateStructuredRequest<T>,
  ): Promise<Result<StructuredResult<T>, ModelError>>;
}

/** Cost in minor units from configured per-million-token rates (no prices live in code). */
export function tokenCostMinor(
  usage: { inputTokens: number; outputTokens: number },
  rates: { inputPerMillionMinor?: number; outputPerMillionMinor?: number } = {},
): number {
  const c =
    (usage.inputTokens * (rates.inputPerMillionMinor ?? 0) +
      usage.outputTokens * (rates.outputPerMillionMinor ?? 0)) /
    1_000_000;
  return Math.ceil(c);
}

/** Rough token estimate (~4 characters per token) for providers that report none. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Parses a model's text answer into the schema. Tolerates a ```json fence and leading/trailing
 * prose around one JSON object; anything else is malformed_output, a JSON value that fails the
 * schema is schema_mismatch. Never throws.
 */
export function parseStructuredOutput<T>(
  text: string,
  schema: z.ZodType<T>,
): Result<T, Pick<ModelError, "code" | "message">> {
  let body = text.trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) body = fence[1].trim();
  if (!body.startsWith("{") && !body.startsWith("[")) {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start < 0 || end <= start)
      return fail({ code: "malformed_output", message: "Model output contains no JSON object" });
    body = body.slice(start, end + 1);
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (err) {
    return fail({
      code: "malformed_output",
      message:
        `Model output is not valid JSON: ${err instanceof Error ? err.message : String(err)}`.slice(
          0,
          300,
        ),
    });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success)
    return fail({
      code: "schema_mismatch",
      message: `Model output does not match the schema: ${parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`.slice(0, 500),
    });
  return ok(parsed.data);
}
