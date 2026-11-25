import { z } from "zod";
import type { ModelError } from "@kalpix/core";

export type ModelFetch = (input: string, init?: RequestInit) => Promise<Response>;

export const DEFAULT_MODEL_TIMEOUT_MS = 60_000;

/** JSON schema for providers that accept one (Ollama `format`). Undefined if zod cannot convert. */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> | undefined {
  try {
    const s = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<
      string,
      unknown
    >;
    delete s.$schema;
    return s;
  } catch {
    return undefined;
  }
}

/** fetch with a timeout; failures come back as ModelError, never thrown. */
export async function fetchJson(
  fetchImpl: ModelFetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  outer?: AbortSignal,
): Promise<{ ok: true; status: number; body: unknown } | { ok: false; error: ModelError }> {
  const signal = outer
    ? AbortSignal.any([outer, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal });
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === "TimeoutError" || name === "AbortError")
      return { ok: false, error: { code: "timeout", message: `No answer within ${timeoutMs} ms` } };
    return {
      ok: false,
      error: {
        code: "http",
        message: `Request failed: ${(err as Error)?.message ?? String(err)}`.slice(0, 300),
      },
    };
  }
  let body: unknown = null;
  const text = await res.text().catch(() => "");
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg =
      (body as { error?: { message?: string } | string } | null)?.error ?? text.slice(0, 200);
    return {
      ok: false,
      error: {
        code: "http",
        message:
          `HTTP ${res.status}${res.status === 429 ? " (rate limited / free-tier quota)" : ""}: ${
            typeof msg === "string" ? msg : (msg?.message ?? "")
          }`.slice(0, 300),
      },
    };
  }
  if (body === null)
    return { ok: false, error: { code: "malformed_output", message: "Response is not JSON" } };
  return { ok: true, status: res.status, body };
}
