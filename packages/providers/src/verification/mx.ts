import { promises as dns } from "node:dns";
import type { MxLookup, MxResolver } from "@kalpix/core";

/** The slice of node:dns the resolver uses; tests inject a fake so no lookup hits the network. */
export interface DnsLike {
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>;
}

export const DEFAULT_DNS_TIMEOUT_MS = 3000;
const OK_TTL_MS = 24 * 3600_000;
const NEGATIVE_TTL_MS = 3600_000;

/**
 * MX lookups with a hard timeout and an in-process cache (positive answers 24 h, NXDOMAIN /
 * no-MX 1 h; timeouts and errors are not cached so the next run retries). Never throws.
 */
export class DnsMxResolver implements MxResolver {
  private readonly cache = new Map<string, { at: number; result: MxLookup }>();
  private readonly dns: DnsLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  lookups = 0;

  constructor(opts: { timeoutMs?: number; dns?: DnsLike; now?: () => number } = {}) {
    this.timeoutMs = Math.max(100, opts.timeoutMs ?? DEFAULT_DNS_TIMEOUT_MS);
    this.dns = opts.dns ?? new dns.Resolver({ timeout: this.timeoutMs, tries: 1 });
    this.now = opts.now ?? Date.now;
  }

  async lookup(rawDomain: string): Promise<MxLookup> {
    const domain = rawDomain.trim().toLowerCase().replace(/\.$/, "");
    const hit = this.cache.get(domain);
    if (hit) {
      const ttl = hit.result.status === "ok" ? OK_TTL_MS : NEGATIVE_TTL_MS;
      if (this.now() - hit.at < ttl) return hit.result;
      this.cache.delete(domain);
    }
    this.lookups++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<MxLookup>((resolve) => {
      timer = setTimeout(() => resolve({ status: "timeout" }), this.timeoutMs);
    });
    const query = this.dns.resolveMx(domain).then(
      (records): MxLookup => {
        if (!records.length) return { status: "no_mx" };
        if (records.length === 1 && (records[0]!.exchange === "" || records[0]!.exchange === "."))
          return { status: "null_mx" };
        return {
          status: "ok",
          exchanges: [...records]
            .sort((a, b) => a.priority - b.priority)
            .map((r) => r.exchange.toLowerCase()),
        };
      },
      (err: unknown): MxLookup => {
        const code = (err as { code?: string })?.code;
        if (code === "ENOTFOUND" || code === "NXDOMAIN") return { status: "nxdomain" };
        if (code === "ENODATA") return { status: "no_mx" };
        if (code === "ETIMEOUT" || code === "ETIMEDOUT") return { status: "timeout" };
        return {
          status: "error",
          error: String(code ?? (err as Error)?.message ?? err).slice(0, 100),
        };
      },
    );
    const result = await Promise.race([query, timeout]).finally(() => clearTimeout(timer));
    if (result.status !== "timeout" && result.status !== "error")
      this.cache.set(domain, { at: this.now(), result });
    return result;
  }
}

/** Fixed answers by domain, for tests and MOCK runs. Unknown domains answer nxdomain. */
export class StaticMxResolver implements MxResolver {
  lookups = 0;
  constructor(private readonly answers: Record<string, MxLookup>) {}
  async lookup(domain: string): Promise<MxLookup> {
    this.lookups++;
    return this.answers[domain.toLowerCase()] ?? { status: "nxdomain" };
  }
}
