import {
  fail,
  FACT_SOURCE_URL_MAX,
  ok,
  type ProviderDescriptor,
  type ProviderHealth,
  type ResearchFact,
  type Result,
  type WebsiteResearchInput,
  type WebsiteResearchProvider,
  type WebsiteResearchResult,
  type WebsiteSignals,
} from "@kalpix/core";
import type { Sleep } from "../rate-limiter";
import { normalizeWebsite } from "../osm/normalize";
import {
  candidatePages,
  dedupeFacts,
  extractPage,
  socialOrMarketplaceHost,
  type ExtractedFact,
} from "./extract";
import { DEFAULT_MAX_BYTES, PoliteFetcher, type PageFetch } from "./fetcher";
import { detectTech, parseHttpDate } from "./signals";
import { NodeHttpTransport, type HttpTransport } from "./transport";

export const HTTP_RESEARCH_DESCRIPTOR: ProviderDescriptor = {
  id: "http-extractor",
  name: "HTTP + schema.org extractor",
  category: "research",
  costTier: "free",
  requiredSecrets: [],
  commercialUseVerified: true, // in-house code; each site's robots.txt is honoured per request
};

export const WEBSITE_FACT_USAGE =
  "Published by the business on its own public website; collected with robots.txt honoured. " +
  "Use only to assess and contact this business; do not resell or republish. Personal data " +
  "(e.g. a named person's email or mobile) is subject to India's DPDP Act 2023.";

/** Policy floor for RESEARCH_HOST_DELAY_MS (fair use of small business sites). */
export const MIN_HOST_DELAY_MS = 2000;
export const DEFAULT_MAX_PAGES = 5;
export const PRODUCT_TOKEN = "KalpixBot";

export interface HttpResearchOptions {
  userAgent: string;
  hostDelayMs?: number;
  maxPages?: number;
  timeoutMs?: number;
  maxBytes?: number;
  transport?: HttpTransport;
  /**
   * TEST ONLY: allow loopback addresses, any port and a host delay below the 2 s floor, so
   * integration tests can use an in-process server on 127.0.0.1. Refused when appEnv=production.
   */
  allowLoopbackForTests?: boolean;
  appEnv?: string;
  now?: () => Date;
  /** Millisecond clock for rate limiting (tests pair it with a fake sleep). */
  clock?: () => number;
  sleep?: Sleep;
}

export class HttpResearchProvider implements WebsiteResearchProvider {
  readonly descriptor = HTTP_RESEARCH_DESCRIPTOR;
  private readonly fetcher: PoliteFetcher;
  private readonly maxPages: number;
  private readonly now: () => Date;

  constructor(opts: HttpResearchOptions) {
    const testMode = Boolean(opts.allowLoopbackForTests);
    if (testMode && opts.appEnv === "production")
      throw new Error("allowLoopbackForTests is not allowed in production");
    const delay = opts.hostDelayMs ?? MIN_HOST_DELAY_MS;
    this.maxPages = Math.min(20, Math.max(1, Math.floor(opts.maxPages ?? DEFAULT_MAX_PAGES)));
    this.now = opts.now ?? (() => new Date());
    const policy = { allowLoopback: testMode };
    this.fetcher = new PoliteFetcher({
      transport: opts.transport ?? new NodeHttpTransport(policy),
      userAgent: opts.userAgent,
      productToken: PRODUCT_TOKEN,
      hostDelayMs: testMode ? Math.max(0, delay) : Math.max(MIN_HOST_DELAY_MS, delay),
      timeoutMs: opts.timeoutMs ?? 15_000,
      maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
      maxRedirects: 5,
      policy,
      sleep: opts.sleep,
      now: opts.clock,
    });
  }

  get requestsMade() {
    return this.fetcher.requests;
  }

  async healthCheck(): Promise<ProviderHealth> {
    return { status: "connected", checkedAt: new Date(), detail: "In-house fetcher; no API" };
  }

  async research(input: WebsiteResearchInput): Promise<Result<WebsiteResearchResult>> {
    const collectedAt = this.now();
    const before = this.fetcher.requests;
    const done = (
      status: WebsiteResearchResult["status"],
      signals: WebsiteSignals,
      facts: ExtractedFact[] = [],
    ): Result<WebsiteResearchResult> => {
      const stamped: ResearchFact[] = dedupeFacts(facts)
        .filter((f) => f.sourceUrl.length <= FACT_SOURCE_URL_MAX)
        .map((f) => ({
          ...f,
          collectedAt,
          verificationStatus: "unverified",
          usageRestriction: WEBSITE_FACT_USAGE,
        }));
      return ok({
        status,
        facts: stamped,
        signals,
        requests: this.fetcher.requests - before,
        summary: summarize(status, signals, stamped),
      });
    };

    if (!input.website?.trim()) return done("no_website", { noWebsite: true });
    const website = normalizeWebsite(input.website);
    if (!website)
      return done("broken", {
        noWebsite: false,
        requestedUrl: input.website,
        broken: "invalid_url",
        brokenDetail: "Listed website is not a valid http(s) URL",
      });
    const social = socialOrMarketplaceHost(website);
    if (social)
      return done("no_website", {
        noWebsite: true,
        socialProfileOnly: social,
        requestedUrl: website,
      });

    let home: PageFetch;
    try {
      home = await this.fetcher.fetchPage(website);
    } catch (err) {
      return fail(`Fetcher error: ${err instanceof Error ? err.message : String(err)}`);
    }
    const origin = (() => {
      try {
        return new URL(home.finalUrl ?? website).origin;
      } catch {
        return null;
      }
    })();
    const unsafe = !home.ok && (home.kind === "ssrf_blocked" || home.kind === "invalid_url");
    const robotsPolicy = origin && !unsafe ? await this.fetcher.robotsFor(origin) : undefined;
    const base: WebsiteSignals = {
      noWebsite: false,
      requestedUrl: website,
      finalUrl: home.finalUrl,
      redirectCount: home.redirects,
      robotsTxt: robotsPolicy?.source ?? "not_checked",
      crawlDelaySeconds: robotsPolicy?.crawlDelaySeconds,
    };
    if (!home.ok) {
      if (home.kind === "robots")
        return done("blocked", { ...base, blockedByRobots: true, brokenDetail: home.detail });
      return done("broken", {
        ...base,
        httpStatus: home.status,
        broken: home.kind,
        brokenDetail: home.detail,
      });
    }

    const res = home.response;
    const ctype = (res.headers["content-type"] ?? "").toLowerCase();
    const html = decodeBody(res.body, ctype);
    const finalUrl = new URL(home.finalUrl);
    const signals: WebsiteSignals = {
      ...base,
      finalUrl: home.finalUrl,
      httpStatus: res.status,
      https: finalUrl.protocol === "https:",
      redirectedToHttps: website.startsWith("http:") && finalUrl.protocol === "https:",
      responseTimeMs: res.timeMs,
      pageBytes: res.body.length,
      truncated: res.truncated || undefined,
      lastModified: parseHttpDate(res.headers["last-modified"]),
      server: res.headers.server?.slice(0, 100),
    };
    if (ctype && !ctype.includes("html") && !/^\s*</.test(html.slice(0, 200)))
      return done("broken", {
        ...signals,
        broken: "not_html",
        brokenDetail: `Homepage content-type ${ctype.slice(0, 80)}`,
      });

    const page = extractPage(html, home.finalUrl, { isHome: true, now: collectedAt });
    const facts: ExtractedFact[] = [...page.facts];
    Object.assign(signals, {
      hasViewport: page.hasViewport,
      hasTitle: Boolean(page.title),
      hasMetaDescription: Boolean(page.metaDescription),
      generator: page.generator?.slice(0, 100),
      copyrightYear: page.copyrightYear,
      tech: detectTech(html, res.headers, page.generator),
    });

    // A few same-site pages likely to carry contact details. A crawl-delay above the cap means
    // the site asked for very slow crawling: homepage only.
    const pageUrls = [home.finalUrl];
    const extra = this.fetcher.crawlDelayExceedsCap(finalUrl.origin)
      ? []
      : candidatePages(page.links, home.finalUrl, this.maxPages - 1);
    for (const url of extra) {
      const p = await this.fetcher.fetchPage(url);
      if (!p.ok) continue;
      const ct = (p.response.headers["content-type"] ?? "").toLowerCase();
      if (ct && !ct.includes("html")) continue;
      if (pageUrls.includes(p.finalUrl)) continue;
      pageUrls.push(p.finalUrl);
      facts.push(
        ...extractPage(decodeBody(p.response.body, ct), p.finalUrl, {
          isHome: false,
          now: collectedAt,
        }).facts,
      );
    }
    signals.pagesFetched = pageUrls.length;
    signals.pageUrls = pageUrls;
    return done("ok", signals, facts);
  }
}

function decodeBody(body: Buffer, contentType: string): string {
  const cs = contentType.match(/charset=["']?([\w-]+)/)?.[1]?.toLowerCase();
  if (cs && cs !== "utf-8" && cs !== "utf8") {
    try {
      return new TextDecoder(cs).decode(body);
    } catch {
      /* unknown charset: fall through */
    }
  }
  return body.toString("utf8");
}

/** Plain-language, score-free observation summary. */
export function summarize(
  status: WebsiteResearchResult["status"],
  s: WebsiteSignals,
  facts: Pick<ResearchFact, "field">[],
): string {
  if (status === "no_website")
    return s.socialProfileOnly
      ? `No own website; the listed site is a ${s.socialProfileOnly} profile.`
      : "No website listed.";
  if (status === "blocked")
    return `Website not fetched: ${s.brokenDetail ?? "disallowed by robots.txt"}.`;
  if (status === "broken")
    return `Website broken (${s.broken ?? "unknown"}${s.httpStatus ? `, HTTP ${s.httpStatus}` : ""}): ${s.brokenDetail ?? ""}`.trim();
  const count = (f: string) => facts.filter((x) => x.field === f).length;
  const socials = facts.filter((x) => x.field.startsWith("social_")).length;
  const parts = [
    `Website reachable (HTTP ${s.httpStatus}) over ${s.https ? "HTTPS" : "plain HTTP"}${s.redirectedToHttps ? " after redirect" : ""}`,
    s.hasViewport ? "has a mobile viewport tag" : "no mobile viewport tag",
    s.hasTitle ? "has a title" : "no page title",
    s.hasMetaDescription ? "has a meta description" : "no meta description",
  ];
  if (s.copyrightYear) parts.push(`copyright ${s.copyrightYear}`);
  if (s.tech?.length) parts.push(`tech: ${s.tech.join(", ")}`);
  const found = `found ${count("phone")} phone(s), ${count("email")} email(s), ${socials} social link(s), ${count("whatsapp")} WhatsApp on ${s.pagesFetched ?? 1} page(s)`;
  return `${parts.join("; ")}; ${found}.`;
}
