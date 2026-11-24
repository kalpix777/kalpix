/**
 * Website research contract (Phase 4). Adapters live in @kalpix/providers (HTTP + schema.org,
 * MOCK); the job runner in apps/worker. Every value found is a ResearchFact carrying the
 * provenance required by docs/ARCHITECTURE.md "Data provenance". No AI and no scoring here:
 * qualification is Phase 5.
 */
import type { Provider, Result } from "./provider";

/**
 * Where a fact came from.
 * - jsonld / microdata / meta / html / header / robots: the business's own website
 * - osm: the OpenStreetMap record the business was discovered from
 * - listing: another discovery provider's record (e.g. the MOCK discovery provider)
 * - mock: the MOCK research provider (tests only)
 */
export const RESEARCH_SOURCE_TYPES = [
  "jsonld",
  "microdata",
  "meta",
  "html",
  "header",
  "robots",
  "osm",
  "listing",
  "mock",
] as const;
export type ResearchSourceType = (typeof RESEARCH_SOURCE_TYPES)[number];

export const VERIFICATION_STATUSES = ["unverified", "verified", "conflicting"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const RESEARCH_FIELDS = [
  "name",
  "phone",
  "email",
  "whatsapp",
  "website",
  "address",
  "postcode",
  "geo",
  "opening_hours",
  "price_range",
  "same_as",
  "social_facebook",
  "social_instagram",
  "social_x",
  "social_linkedin",
  "social_youtube",
  "page_title",
  "meta_description",
  "og_title",
  "og_description",
  "og_site_name",
] as const;
export type ResearchField = (typeof RESEARCH_FIELDS)[number];

export interface ResearchFact {
  field: ResearchField;
  value: string; // as found (trimmed, length-capped)
  normalizedValue: string; // comparison key: E.164 phone, lower-case email, canonical URL ...
  // provenance
  sourceUrl: string;
  collectedAt: Date;
  sourceType: ResearchSourceType;
  confidence: number; // 0..1, how reliable the extraction method is, NOT a verification
  verificationStatus: VerificationStatus;
  usageRestriction?: string;
}

/** Length caps keep the (businessId, field, normalizedValue, sourceUrl) unique index valid. */
export const FACT_VALUE_MAX = 1000;
export const FACT_NORMALIZED_MAX = 400;
export const FACT_SOURCE_URL_MAX = 500;

export const BROKEN_KINDS = [
  "invalid_url",
  "dns",
  "tls",
  "timeout",
  "network",
  "http_4xx",
  "http_5xx",
  "too_many_redirects",
  "ssrf_blocked",
  "too_large",
  "not_html",
] as const;
export type BrokenKind = (typeof BROKEN_KINDS)[number];

/** Website quality signals. Observations only; no score is derived in Phase 4. */
export interface WebsiteSignals {
  noWebsite: boolean;
  /** The listed "website" is a social/marketplace profile, not an own site. */
  socialProfileOnly?: string;
  requestedUrl?: string;
  finalUrl?: string;
  httpStatus?: number;
  https?: boolean;
  redirectedToHttps?: boolean;
  redirectCount?: number;
  hasViewport?: boolean; // <meta name="viewport">: mobile-friendly hint only
  hasTitle?: boolean;
  hasMetaDescription?: boolean;
  responseTimeMs?: number;
  pageBytes?: number;
  truncated?: boolean;
  lastModified?: string; // ISO, from the Last-Modified header
  copyrightYear?: number;
  generator?: string;
  tech?: string[];
  server?: string;
  broken?: BrokenKind;
  brokenDetail?: string;
  robotsTxt?: "found" | "missing" | "unavailable" | "not_checked";
  blockedByRobots?: boolean;
  crawlDelaySeconds?: number;
  pagesFetched?: number;
  pageUrls?: string[];
}

export type BusinessResearchStatus = "ok" | "no_website" | "broken" | "blocked";

export interface WebsiteResearchInput {
  businessId: string;
  name: string;
  website?: string | null;
}

export interface WebsiteResearchResult {
  status: BusinessResearchStatus;
  facts: ResearchFact[];
  signals: WebsiteSignals;
  /** HTTP requests actually made (robots.txt included), for UsageEvent accounting. */
  requests: number;
  /** Plain-language observation summary. Deliberately score-free. */
  summary: string;
}

export interface WebsiteResearchProvider extends Provider {
  /**
   * Researches one business's website. A broken or blocked site is a successful result with that
   * status; `ok: false` means the provider itself could not run (misconfiguration, test hook).
   */
  research(
    input: WebsiteResearchInput,
    opts?: { signal?: AbortSignal },
  ): Promise<Result<WebsiteResearchResult>>;
}

// ---------------- run scope ----------------

export const RESEARCH_SCOPE_TYPES = ["businesses", "discovery_run", "filter"] as const;
export type ResearchScopeType = (typeof RESEARCH_SCOPE_TYPES)[number];

/** Hard cap on businesses one run may target (fair use of other people's websites). */
export const RESEARCH_MAX_BUSINESSES_PER_RUN = 500;

export interface ResearchFilter {
  category?: string;
  city?: string;
  status?: string;
  hasWebsite?: boolean;
  /** Only businesses never researched, or last researched before this many days ago. */
  staleAfterDays?: number;
  limit?: number;
}

/** Validates a filter scope (stored as JSON on the run). Throws with a readable message. */
export function parseResearchFilter(input: unknown): ResearchFilter {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Research filter must be an object");
  const o = input as Record<string, unknown>;
  const allowed = ["category", "city", "status", "hasWebsite", "staleAfterDays", "limit"];
  const unknown = Object.keys(o).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new Error(`Unknown research filter keys: ${unknown.join(", ")}`);
  const out: ResearchFilter = {};
  for (const k of ["category", "city", "status"] as const) {
    const v = o[k];
    if (v === undefined) continue;
    if (typeof v !== "string" || !v.trim() || v.length > 100)
      throw new Error(`Research filter ${k} must be a non-empty string`);
    out[k] = v.trim();
  }
  if (o.hasWebsite !== undefined) {
    if (typeof o.hasWebsite !== "boolean") throw new Error("hasWebsite must be a boolean");
    out.hasWebsite = o.hasWebsite;
  }
  for (const k of ["staleAfterDays", "limit"] as const) {
    const v = o[k];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1)
      throw new Error(`Research filter ${k} must be a positive integer`);
    out[k] = v;
  }
  if (out.limit !== undefined) out.limit = Math.min(out.limit, RESEARCH_MAX_BUSINESSES_PER_RUN);
  return out;
}

// ---------------- conflict detection ----------------

/** Fields where a listing and the website should agree; others may legitimately differ. */
export const CONFLICT_FIELDS: readonly ResearchField[] = [
  "phone",
  "email",
  "whatsapp",
  "postcode",
  "opening_hours",
];

export type FactOrigin = "listing" | "website";

export function factOrigin(t: ResearchSourceType): FactOrigin {
  return t === "osm" || t === "listing" ? "listing" : "website";
}

/**
 * Conflict rule (documented in docs/DATABASE_SCHEMA.md): for a field in CONFLICT_FIELDS, facts
 * are "conflicting" when BOTH origins (listing record vs the business's website) have values and
 * the two value sets share nothing. One overlapping value means the sources agree (a website
 * listing two phones, one of which OSM also has, is not a conflict). Several values from one
 * origin never conflict with each other.
 * Returns the set of fields in conflict.
 */
export function detectConflicts(
  facts: readonly { field: string; normalizedValue: string; sourceType: string }[],
): Set<string> {
  const byField = new Map<string, { listing: Set<string>; website: Set<string> }>();
  for (const f of facts) {
    if (!(CONFLICT_FIELDS as readonly string[]).includes(f.field)) continue;
    const g = byField.get(f.field) ?? { listing: new Set(), website: new Set() };
    g[factOrigin(f.sourceType as ResearchSourceType)].add(f.normalizedValue);
    byField.set(f.field, g);
  }
  const out = new Set<string>();
  for (const [field, g] of byField) {
    if (!g.listing.size || !g.website.size) continue;
    if (![...g.listing].some((v) => g.website.has(v))) out.add(field);
  }
  return out;
}
