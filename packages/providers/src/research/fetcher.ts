import type { BrokenKind } from "@kalpix/core";
import { realSleep, type Sleep } from "../rate-limiter";
import {
  ALLOW_ALL,
  DENY_ALL,
  isAllowedByRobots,
  parseRobots,
  robotsPath,
  type RobotsPolicy,
} from "./robots";
import { assertUrlAllowed, SsrfError, type UrlPolicy } from "./ssrf";
import {
  classifyNetworkError,
  TransportError,
  type HttpTransport,
  type TransportResponse,
} from "./transport";

/**
 * Per-host minimum interval between request starts. Hosts are independent, requests to one
 * host are serialised. In-process only (one worker), like RateLimiter.
 */
export class HostRateLimiter {
  private readonly hosts = new Map<string, { chain: Promise<unknown>; lastStart: number }>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly sleep: Sleep = realSleep,
  ) {}

  schedule<T>(host: string, minIntervalMs: number, fn: () => Promise<T>): Promise<T> {
    const h = this.hosts.get(host) ?? {
      chain: Promise.resolve(),
      lastStart: Number.NEGATIVE_INFINITY,
    };
    this.hosts.set(host, h);
    const run = async () => {
      const wait = h.lastStart + minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      h.lastStart = this.now();
      return fn();
    };
    const result = h.chain.then(run, run);
    h.chain = result.catch(() => undefined);
    return result;
  }
}

export interface PoliteFetcherOptions {
  transport: HttpTransport;
  userAgent: string;
  /** robots.txt product token, e.g. "KalpixBot". */
  productToken: string;
  hostDelayMs: number;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  robotsTtlMs?: number;
  /** Crawl-delay above this is capped (and the caller fetches the homepage only). */
  maxCrawlDelaySeconds?: number;
  policy?: UrlPolicy;
  now?: () => number;
  sleep?: Sleep;
}

export type PageFetch =
  | {
      ok: true;
      requestedUrl: string;
      finalUrl: string;
      redirects: number;
      response: TransportResponse;
    }
  | {
      ok: false;
      kind: BrokenKind | "robots";
      detail: string;
      requestedUrl: string;
      finalUrl?: string;
      status?: number;
      redirects: number;
    };

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const ROBOTS_MAX_BYTES = 512 * 1024;

/**
 * Polite fetcher: identifying User-Agent, robots.txt (cached per origin, RFC 9309 semantics:
 * 4xx = allow all, 5xx/unreachable = deny all), per-host delay of max(hostDelayMs, Crawl-delay),
 * timeouts, byte cap, <= maxRedirects redirects with the SSRF and robots checks repeated on
 * every hop.
 */
export class PoliteFetcher {
  requests = 0;
  private readonly robots = new Map<string, { policy: RobotsPolicy; at: number }>();
  private readonly limiter: HostRateLimiter;
  private readonly o: Required<Omit<PoliteFetcherOptions, "policy">> & { policy: UrlPolicy };

  constructor(opts: PoliteFetcherOptions) {
    this.o = {
      timeoutMs: 15_000,
      maxBytes: DEFAULT_MAX_BYTES,
      maxRedirects: 5,
      robotsTtlMs: 24 * 60 * 60 * 1000,
      maxCrawlDelaySeconds: 30,
      policy: {},
      now: Date.now,
      sleep: realSleep,
      // explicit `undefined` options must not erase the defaults above
      ...(Object.fromEntries(
        Object.entries(opts).filter(([, v]) => v !== undefined),
      ) as PoliteFetcherOptions),
    };
    this.limiter = new HostRateLimiter(this.o.now, this.o.sleep);
  }

  /** Effective delay for a host after robots.txt has been read. */
  delayFor(origin: string): number {
    const cd = this.robots.get(origin)?.policy.crawlDelaySeconds ?? 0;
    return Math.max(this.o.hostDelayMs, Math.min(cd, this.o.maxCrawlDelaySeconds) * 1000);
  }

  crawlDelayExceedsCap(origin: string): boolean {
    return (this.robots.get(origin)?.policy.crawlDelaySeconds ?? 0) > this.o.maxCrawlDelaySeconds;
  }

  private async get(url: URL, maxBytes: number): Promise<TransportResponse> {
    this.requests++;
    return this.limiter.schedule(url.host, this.delayFor(url.origin), () =>
      this.o.transport.request({
        url,
        headers: {
          "user-agent": this.o.userAgent,
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "accept-language": "en-IN,en;q=0.8",
        },
        timeoutMs: this.o.timeoutMs,
        maxBytes,
      }),
    );
  }

  /**
   * robots.txt for an origin (cached). Never throws: an unreachable or erroring robots.txt comes
   * back as source "unavailable" with the reason, which the caller reports as a broken site.
   */
  async robotsFor(origin: string): Promise<RobotsPolicy> {
    const hit = this.robots.get(origin);
    if (hit && this.o.now() - hit.at < this.o.robotsTtlMs) return hit.policy;
    let policy: RobotsPolicy;
    let url = new URL("/robots.txt", origin);
    try {
      let res: TransportResponse | null = null;
      for (let hop = 0; hop <= this.o.maxRedirects; hop++) {
        assertUrlAllowed(url, this.o.policy);
        res = await this.get(url, ROBOTS_MAX_BYTES);
        const loc = res.headers.location;
        if (!REDIRECTS.has(res.status) || !loc) break;
        url = new URL(loc, url);
        res = null;
      }
      if (!res)
        policy = ALLOW_ALL; // redirect loop on robots.txt: treated as missing
      else if (res.status >= 200 && res.status < 300)
        policy = parseRobots(res.body.toString("utf8"), this.o.productToken);
      else if (res.status >= 400 && res.status < 500) policy = ALLOW_ALL;
      else
        policy = {
          ...DENY_ALL,
          unavailable: { kind: "http_5xx", detail: `robots.txt returned HTTP ${res.status}` },
        };
    } catch (err) {
      const e = classifyNetworkError(err);
      policy = { ...DENY_ALL, unavailable: { kind: e.kind, detail: e.message } };
    }
    this.robots.set(origin, { policy, at: this.o.now() });
    return policy;
  }

  async fetchPage(raw: string): Promise<PageFetch> {
    let url: URL;
    let redirects = 0;
    try {
      url = assertUrlAllowed(raw, this.o.policy);
    } catch (err) {
      return {
        ok: false,
        kind:
          err instanceof SsrfError && /Invalid URL/.test(err.message)
            ? "invalid_url"
            : "ssrf_blocked",
        detail: (err as Error).message,
        requestedUrl: raw,
        redirects,
      };
    }
    for (;;) {
      try {
        assertUrlAllowed(url, this.o.policy);
        const robots = await this.robotsFor(url.origin);
        if (robots.unavailable)
          return {
            ok: false,
            kind: robots.unavailable.kind,
            detail: `${robots.unavailable.detail}; site not fetched (RFC 9309: unreachable robots.txt = disallow)`,
            requestedUrl: raw,
            finalUrl: url.toString(),
            redirects,
          };
        if (!isAllowedByRobots(robots, robotsPath(url)))
          return {
            ok: false,
            kind: "robots",
            detail: `Disallowed by robots.txt: ${robotsPath(url)}`,
            requestedUrl: raw,
            finalUrl: url.toString(),
            redirects,
          };
        const res = await this.get(url, this.o.maxBytes);
        const loc = res.headers.location;
        if (REDIRECTS.has(res.status) && loc) {
          if (redirects >= this.o.maxRedirects)
            return {
              ok: false,
              kind: "too_many_redirects",
              detail: `More than ${this.o.maxRedirects} redirects`,
              requestedUrl: raw,
              finalUrl: url.toString(),
              status: res.status,
              redirects,
            };
          let next: URL;
          try {
            next = new URL(loc, url);
          } catch {
            return {
              ok: false,
              kind: "invalid_url",
              detail: "Invalid redirect location",
              requestedUrl: raw,
              redirects,
            };
          }
          redirects++;
          url = next;
          continue;
        }
        if (res.status >= 400)
          return {
            ok: false,
            kind: res.status >= 500 ? "http_5xx" : "http_4xx",
            detail: `HTTP ${res.status}`,
            requestedUrl: raw,
            finalUrl: url.toString(),
            status: res.status,
            redirects,
          };
        return { ok: true, requestedUrl: raw, finalUrl: url.toString(), redirects, response: res };
      } catch (err) {
        const e = err instanceof TransportError ? err : classifyNetworkError(err);
        return {
          ok: false,
          kind: e.kind,
          detail: e.message,
          requestedUrl: raw,
          finalUrl: url.toString(),
          redirects,
        };
      }
    }
  }
}
