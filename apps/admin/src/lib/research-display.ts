/** Display helpers for the research page and the business detail Research section (pure, unit-tested). */
import type { BrokenKind, WebsiteSignals } from "@kalpix/core";
import type { Tone } from "./discovery-display";

export const RESEARCH_OUTCOMES = ["ok", "no_website", "broken", "blocked", "error"] as const;
export type ResearchOutcome = (typeof RESEARCH_OUTCOMES)[number];

export const RESEARCH_STATUS_TONE: Record<string, Tone> = {
  ok: "green",
  no_website: "neutral",
  broken: "red",
  blocked: "amber",
  error: "red",
};

export const RESEARCH_STATUS_LABEL: Record<string, string> = {
  ok: "Researched",
  no_website: "No website",
  broken: "Website broken",
  blocked: "Blocked by robots.txt",
  error: "Research error",
};

export const researchStatusLabel = (s: string) => RESEARCH_STATUS_LABEL[s] ?? s;

/** Research providers an operator may pick (mock never in production). */
export function selectableResearchProviders(appEnv: string | undefined): ("http" | "mock")[] {
  return appEnv === "production" ? ["http"] : ["http", "mock"];
}

export const RESEARCH_PROVIDER_OPTION_LABEL: Record<string, string> = {
  http: "HTTP + schema.org extractor",
  mock: "MOCK (test data only)",
};

export function researchProviderLabel(providerId: string): string {
  switch (providerId) {
    case "http-extractor":
      return "HTTP + schema.org extractor";
    case "mock-research":
      return "MOCK (test data)";
    default:
      return providerId;
  }
}

export const FIELD_LABEL: Record<string, string> = {
  name: "Name",
  phone: "Phone",
  email: "Email",
  whatsapp: "WhatsApp",
  website: "Website",
  address: "Address",
  postcode: "Postcode",
  geo: "Coordinates",
  opening_hours: "Opening hours",
  price_range: "Price range",
  same_as: "Other profiles",
  social_facebook: "Facebook",
  social_instagram: "Instagram",
  social_x: "X (Twitter)",
  social_linkedin: "LinkedIn",
  social_youtube: "YouTube",
  page_title: "Page title",
  meta_description: "Meta description",
  og_title: "Open Graph title",
  og_description: "Open Graph description",
  og_site_name: "Open Graph site name",
};
export const fieldLabel = (f: string) => FIELD_LABEL[f] ?? f;

/** Display order for the facts table: contact first, page metadata last. */
const FIELD_ORDER = Object.keys(FIELD_LABEL);
export function fieldRank(f: string): number {
  const i = FIELD_ORDER.indexOf(f);
  return i === -1 ? FIELD_ORDER.length : i;
}

export const SOURCE_TYPE_LABEL: Record<string, string> = {
  jsonld: "Website (JSON-LD)",
  microdata: "Website (microdata)",
  meta: "Website (meta tags)",
  html: "Website (page text)",
  header: "Website (HTTP header)",
  robots: "Website (robots.txt)",
  osm: "OpenStreetMap",
  listing: "Discovery listing",
  mock: "MOCK",
};
export const sourceTypeLabel = (t: string) => SOURCE_TYPE_LABEL[t] ?? t;

export interface FactRow {
  field: string;
  value: string;
  verificationStatus: string;
}

/** Groups facts by field in display order; within a field, conflicting first then by value. */
export function groupFacts<T extends FactRow>(
  facts: readonly T[],
): { field: string; facts: T[] }[] {
  const map = new Map<string, T[]>();
  for (const f of facts) {
    const g = map.get(f.field) ?? [];
    g.push(f);
    map.set(f.field, g);
  }
  return [...map.entries()]
    .sort(([a], [b]) => fieldRank(a) - fieldRank(b) || a.localeCompare(b))
    .map(([field, g]) => ({
      field,
      facts: g.sort(
        (a, b) =>
          Number(b.verificationStatus === "conflicting") -
            Number(a.verificationStatus === "conflicting") || a.value.localeCompare(b.value),
      ),
    }));
}

const BROKEN_TEXT: Record<BrokenKind, string> = {
  invalid_url: "The listed website address is not a valid URL",
  dns: "The website's domain does not resolve (DNS failure)",
  tls: "The website's HTTPS certificate failed",
  timeout: "The website did not respond in time",
  network: "The website could not be reached",
  http_4xx: "The website answered with a client error (page missing or refused)",
  http_5xx: "The website answered with a server error",
  too_many_redirects: "The website redirects too many times",
  ssrf_blocked: "The address points to a private or local network and was not fetched",
  too_large: "The homepage is too large to read",
  not_html: "The address does not serve a web page",
};

/**
 * Turns stored WebsiteSignals into short plain-language observations. Observations only: nothing
 * here is a score (qualification is Phase 5).
 */
export function describeSignals(raw: unknown): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const s = raw as Partial<WebsiteSignals>;
  const out: string[] = [];
  if (s.noWebsite) {
    out.push("No website listed for this business.");
    return out;
  }
  if (s.socialProfileOnly)
    out.push(`The listed website is a ${s.socialProfileOnly} profile, not its own website.`);
  if (s.blockedByRobots)
    out.push("The site's robots.txt asks crawlers not to read it, so Kalpix did not fetch pages.");
  if (s.broken)
    out.push(
      `${BROKEN_TEXT[s.broken] ?? s.broken}${s.brokenDetail ? ` (${s.brokenDetail})` : ""}.`,
    );
  if (typeof s.httpStatus === "number" && !s.broken)
    out.push(`Homepage answered HTTP ${s.httpStatus}.`);
  if (s.https === true)
    out.push(s.redirectedToHttps ? "Uses HTTPS (redirects from HTTP)." : "Uses HTTPS.");
  if (s.https === false) out.push("Does not use HTTPS: browsers mark it “Not secure”.");
  if (s.hasViewport === true) out.push("Has a mobile viewport tag (a mobile-friendly hint).");
  if (s.hasViewport === false) out.push("No mobile viewport tag: likely not mobile-friendly.");
  if (s.hasTitle === false) out.push("The homepage has no title.");
  if (s.hasMetaDescription === false) out.push("No meta description for search results.");
  if (s.hasMetaDescription === true) out.push("Has a meta description for search results.");
  if (typeof s.responseTimeMs === "number")
    out.push(`Responded in ${(s.responseTimeMs / 1000).toFixed(1)} s.`);
  if (typeof s.pageBytes === "number")
    out.push(
      `Homepage size ${Math.max(1, Math.round(s.pageBytes / 1024))} KB${s.truncated ? " (read partially)" : ""}.`,
    );
  if (s.copyrightYear) out.push(`Footer copyright year: ${s.copyrightYear}.`);
  if (s.lastModified) out.push(`Server reports last modified ${s.lastModified.slice(0, 10)}.`);
  const tech = [...new Set([...(s.generator ? [s.generator] : []), ...(s.tech ?? [])])];
  if (tech.length) out.push(`Built with: ${tech.join(", ")}.`);
  if (typeof s.redirectCount === "number" && s.redirectCount > 1)
    out.push(`Redirects ${s.redirectCount} times before the homepage.`);
  if (s.robotsTxt === "missing") out.push("No robots.txt file.");
  if (s.crawlDelaySeconds)
    out.push(`robots.txt asks for ${s.crawlDelaySeconds} s between requests.`);
  if (typeof s.pagesFetched === "number" && s.pagesFetched > 0)
    out.push(`${s.pagesFetched} page${s.pagesFetched === 1 ? "" : "s"} read.`);
  return out;
}

export interface ScopeLike {
  scopeType: string;
  businessIds: string[];
  discoveryRunId: string | null;
  filter: unknown;
}

/** One-line description of a research run's scope. */
export function describeScope(
  run: ScopeLike,
  opts: {
    discoveryRunLabel?: (id: string) => string | undefined;
    categoryLabel?: (c: string) => string;
  } = {},
): string {
  if (run.scopeType === "businesses")
    return `${run.businessIds.length} selected business${run.businessIds.length === 1 ? "" : "es"}`;
  if (run.scopeType === "discovery_run") {
    const l = run.discoveryRunId ? opts.discoveryRunLabel?.(run.discoveryRunId) : undefined;
    return `Discovery run: ${l ?? run.discoveryRunId?.slice(0, 8) ?? "?"}`;
  }
  const f = (run.filter && typeof run.filter === "object" ? run.filter : {}) as Record<
    string,
    unknown
  >;
  const parts: string[] = [];
  if (typeof f.category === "string")
    parts.push(opts.categoryLabel ? opts.categoryLabel(f.category) : f.category);
  else parts.push("All categories");
  if (typeof f.city === "string") parts.push(f.city);
  if (f.hasWebsite === true) parts.push("has website");
  if (f.hasWebsite === false) parts.push("no website");
  if (typeof f.staleAfterDays === "number")
    parts.push(`not researched in ${f.staleAfterDays} day${f.staleAfterDays === 1 ? "" : "s"}`);
  if (typeof f.limit === "number") parts.push(`limit ${f.limit}`);
  return `Filter: ${parts.join(", ")}`;
}

export const RESEARCH_DEFAULT_LIMIT = 100;
export const RESEARCH_LIMIT_MAX = 500;

export interface ResearchPrefill {
  scope: "filter" | "discovery_run";
  discoveryRunId: string;
  category: string;
  website: "" | "yes" | "no";
  staleAfterDays: string;
  limit: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads the start-form prefill from the /research query string (from "Research these" on
 * Businesses or a link elsewhere). Untrusted: anything invalid falls back to the blank default.
 */
export function parseResearchPrefill(
  sp: Record<string, string | string[] | undefined>,
  isCategory: (c: string) => boolean,
): ResearchPrefill {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
  const runId = one(sp.discoveryRunId);
  const validRun = UUID.test(runId) ? runId : "";
  const scope = one(sp.scope) === "discovery_run" && validRun ? "discovery_run" : "filter";
  const category = one(sp.category);
  const website = one(sp.website);
  const intIn = (raw: string, min: number, max: number) => {
    if (!/^\d{1,4}$/.test(raw)) return "";
    const n = Number(raw);
    return n >= min && n <= max ? String(n) : "";
  };
  return {
    scope,
    discoveryRunId: validRun,
    category: isCategory(category) ? category : "",
    website: website === "yes" || website === "no" ? website : "",
    staleAfterDays: intIn(one(sp.staleAfterDays), 1, 3650),
    limit: intIn(one(sp.limit), 1, RESEARCH_LIMIT_MAX) || String(RESEARCH_DEFAULT_LIMIT),
  };
}

export interface BusinessListFilters {
  category?: string;
  website?: string;
  phone?: string;
  q?: string;
  run?: string;
  research?: string;
}

/**
 * Builds the "Research these" link from the Businesses list filters. A run filter becomes a
 * discovery-run scope; category and website carry over as a filter scope. Filters research runs
 * cannot express (search text, phone, research status other than "never") are reported so the
 * page can say so instead of silently widening the set.
 */
export function researchLinkForBusinessFilters(f: BusinessListFilters): {
  href: string;
  dropped: string[];
} {
  const p = new URLSearchParams();
  const dropped: string[] = [];
  if (f.run) {
    p.set("scope", "discovery_run");
    p.set("discoveryRunId", f.run);
    if (f.category) dropped.push("category");
    if (f.website) dropped.push("website");
  } else {
    p.set("scope", "filter");
    if (f.category) p.set("category", f.category);
    if (f.website === "yes" || f.website === "no") p.set("website", f.website);
    // "never researched" is approximated by "not researched in 3650 days" (never, or > 10 years)
    if (f.research === "never") p.set("staleAfterDays", "3650");
  }
  if (f.q) dropped.push("search");
  if (f.phone) dropped.push("phone");
  if (f.research && !(f.research === "never" && !f.run)) dropped.push("research status");
  return { href: `/research?${p.toString()}`, dropped };
}

/** Per-outcome counts of a run, in display order. */
export function outcomeCounts(r: {
  okCount: number;
  noWebsiteCount: number;
  brokenCount: number;
  blockedCount: number;
  errorCount: number;
}): { outcome: ResearchOutcome; count: number }[] {
  return [
    { outcome: "ok", count: r.okCount },
    { outcome: "no_website", count: r.noWebsiteCount },
    { outcome: "broken", count: r.brokenCount },
    { outcome: "blocked", count: r.blockedCount },
    { outcome: "error", count: r.errorCount },
  ];
}
