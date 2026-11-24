import { realSleep, type Sleep } from "./rate-limiter";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RetryOptions {
  timeoutMs: number;
  retries: number; // additional attempts after the first
  baseDelayMs: number; // exponential backoff base
  maxDelayMs: number;
  fetchImpl?: FetchLike;
  sleep?: Sleep;
  signal?: AbortSignal;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly attempts: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export function backoffDelay(
  attempt: number,
  base: number,
  max: number,
  retryAfter?: string | null,
) {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, max);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.min(Math.max(0, at - Date.now()), max);
  }
  return Math.min(base * 2 ** attempt, max);
}

/**
 * fetch with a per-attempt timeout and exponential backoff on network errors, 408/425/429/5xx.
 * Honours Retry-After. Never retries other 4xx (they are our fault, retrying would be abusive).
 * Returns the successful Response; throws HttpError otherwise.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions,
): Promise<{ response: Response; attempts: number }> {
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const sleep = opts.sleep ?? realSleep;
  let lastError = "unknown error";
  let lastStatus: number | null = null;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    if (opts.signal?.aborted) throw new HttpError("Aborted", null, attempt);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    const onAbort = () => ctrl.abort();
    opts.signal?.addEventListener("abort", onAbort);
    let retryAfter: string | null = null;
    try {
      const response = await doFetch(url, { ...init, signal: ctrl.signal });
      if (response.ok) return { response, attempts: attempt + 1 };
      lastStatus = response.status;
      lastError = `HTTP ${response.status}`;
      const body = await response.text().catch(() => "");
      if (body) lastError += `: ${body.replace(/\s+/g, " ").slice(0, 200)}`;
      if (!RETRYABLE.has(response.status))
        throw new HttpError(lastError, response.status, attempt + 1);
      retryAfter = response.headers.get("retry-after");
    } catch (err) {
      if (err instanceof HttpError) throw err;
      lastStatus = null;
      lastError = ctrl.signal.aborted
        ? `Timed out after ${opts.timeoutMs} ms`
        : `Network error: ${err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err)}`;
      if (opts.signal?.aborted) throw new HttpError("Aborted", null, attempt + 1);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
    if (attempt < opts.retries)
      await sleep(backoffDelay(attempt, opts.baseDelayMs, opts.maxDelayMs, retryAfter));
  }
  throw new HttpError(
    `${lastError} (after ${opts.retries + 1} attempts)`,
    lastStatus,
    opts.retries + 1,
  );
}
