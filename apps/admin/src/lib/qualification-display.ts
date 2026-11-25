/** Display helpers for the Lead Qualification page and the business detail Qualification section
 *  (pure, unit-tested). Scores and tiers come only from the rules engine; AI text is a suggestion. */
import type { Prisma } from "@prisma/client";
import type { Tone } from "./discovery-display";

export const TIERS = ["hot", "warm", "cold", "disqualified"] as const;
export type Tier = (typeof TIERS)[number];
export const isTier = (v: string): v is Tier => (TIERS as readonly string[]).includes(v);

export const TIER_TONE: Record<string, Tone> = {
  hot: "red",
  warm: "amber",
  cold: "neutral",
  disqualified: "neutral",
};
export const TIER_LABEL: Record<string, string> = {
  hot: "Hot",
  warm: "Warm",
  cold: "Cold",
  disqualified: "Disqualified",
};
export const tierLabel = (t: string | null | undefined) => (t ? (TIER_LABEL[t] ?? t) : "—");

/** Per-tier counts of a run, in display order. */
export function tierCounts(r: {
  hotCount: number;
  warmCount: number;
  coldCount: number;
  disqualifiedCount: number;
}): { tier: Tier; count: number }[] {
  return [
    { tier: "hot", count: r.hotCount },
    { tier: "warm", count: r.warmCount },
    { tier: "cold", count: r.coldCount },
    { tier: "disqualified", count: r.disqualifiedCount },
  ];
}

export const DISQUALIFIED_LABEL: Record<string, string> = {
  closed: "Closed or disused",
  no_contact_channel: "No usable contact channel",
  duplicate: "Duplicate record",
  blocked_category: "Blocked category",
};
export const disqualifiedLabel = (c: string | null | undefined) =>
  c ? (DISQUALIFIED_LABEL[c] ?? c) : "—";

export const OPERATING_LABEL: Record<string, string> = {
  closed: "Closed (strong evidence)",
  possibly_closed: "Possibly closed",
  no_evidence: "No sign of closure",
};
export const OPERATING_TONE: Record<string, Tone> = {
  closed: "red",
  possibly_closed: "amber",
  no_evidence: "green",
};

// ---------- AI providers ----------

export const AI_KINDS = ["mock", "ollama", "gemini"] as const;
export type AiKind = (typeof AI_KINDS)[number];

export const AI_PROVIDER_LABEL: Record<string, string> = {
  none: "Off (rules only)",
  mock: "MOCK model (test data only)",
  "mock-model": "MOCK model (test data only)",
  ollama: "Ollama (local)",
  gemini: "Google Gemini API",
};
export const aiProviderLabel = (id: string | null | undefined) =>
  id ? (AI_PROVIDER_LABEL[id] ?? id) : "Off (rules only)";

export const AI_STATUS_TONE: Record<string, Tone> = {
  off: "neutral",
  skipped: "neutral",
  ok: "green",
  error: "red",
};

/** AI providers an operator may pick: only ready ones, MOCK never in production. */
export function selectableAiKinds(
  statuses: readonly { kind: AiKind; ready: boolean }[],
  appEnv: string | undefined,
): AiKind[] {
  return statuses
    .filter((s) => s.ready && !(s.kind === "mock" && appEnv === "production"))
    .map((s) => s.kind);
}

// ---------- reasons ----------

export interface Reason {
  code: string;
  kind: string;
  points: number;
  text: string;
  factIds: string[];
  researchId?: string;
}

/** Reads stored reasons JSON defensively (bad entries are dropped). */
export function parseReasons(raw: unknown): Reason[] {
  if (!Array.isArray(raw)) return [];
  const out: Reason[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.code !== "string" || typeof o.text !== "string") continue;
    out.push({
      code: o.code,
      kind: typeof o.kind === "string" ? o.kind : "note",
      points: typeof o.points === "number" && Number.isFinite(o.points) ? o.points : 0,
      text: o.text,
      factIds: Array.isArray(o.factIds)
        ? o.factIds.filter((x): x is string => typeof x === "string")
        : [],
      ...(typeof o.researchId === "string" ? { researchId: o.researchId } : {}),
    });
  }
  return out;
}

/** The one reason a ranked list shows: the disqualification for disqualified leads, otherwise the
 *  opportunity or contact reason carrying the most points. */
export function topReason(reasons: readonly Reason[], tier: string | null): Reason | null {
  if (tier === "disqualified")
    return reasons.find((r) => r.kind === "disqualification") ?? reasons[0] ?? null;
  const scored = reasons
    .filter((r) => r.kind === "opportunity" || r.kind === "contact")
    .sort((a, b) => b.points - a.points);
  return scored[0] ?? reasons.find((r) => r.kind !== "note") ?? null;
}

export interface ContactChannel {
  channel: "phone" | "whatsapp" | "email";
  verified: boolean;
}

/** Which contact channels the rules counted, from the reason codes. */
export function contactChannels(reasons: readonly Reason[]): ContactChannel[] {
  const out: ContactChannel[] = [];
  for (const ch of ["phone", "whatsapp", "email"] as const) {
    if (reasons.some((r) => r.code === `verified_${ch}`)) out.push({ channel: ch, verified: true });
    else if (reasons.some((r) => r.code === ch)) out.push({ channel: ch, verified: false });
  }
  return out;
}

export const CHANNEL_LABEL: Record<string, string> = {
  phone: "Phone",
  whatsapp: "WhatsApp",
  email: "Email",
};

export interface Components {
  website: number;
  contact: number;
  category: number;
}
export function parseComponents(raw: unknown): Components {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return { website: n(o.website), contact: n(o.contact), category: n(o.category) };
}

export interface AiRisk {
  code: string;
  text: string;
  factIds: string[];
}
export function parseAiRisks(raw: unknown): AiRisk[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .filter((r) => typeof r.text === "string")
    .map((r) => ({
      code: typeof r.code === "string" ? r.code : "other",
      text: r.text as string,
      factIds: Array.isArray(r.factIds)
        ? r.factIds.filter((x): x is string => typeof x === "string")
        : [],
    }));
}

// ---------- fact verification ----------

export const VERIFICATION_TONE: Record<string, Tone> = {
  verified: "green",
  conflicting: "amber",
  invalid: "red",
  unverified: "neutral",
};

export const METHOD_LABEL: Record<string, string> = {
  phone_format_agreement: "Phone format + source agreement",
  email_syntax_mx: "Email syntax + mail domain (MX)",
  website_reachability: "Website reachability",
  postcode_format_state: "PIN format + state",
  conflict_check: "Source conflict check",
  manual: "Manual override",
};
export const methodLabel = (m: string | null | undefined) =>
  m ? (METHOD_LABEL[m] ?? m) : "Not checked yet";

/** Short plain-language summary of stored verification evidence. Never echoes raw JSON blobs. */
export function evidenceSummary(raw: unknown): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  const e = raw as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof e.reason === "string") parts.push(e.reason);
  const sources = e.sources ?? e.independentSources;
  if (Array.isArray(sources) && sources.length)
    parts.push(`${sources.length} independent source${sources.length === 1 ? "" : "s"}`);
  else if (typeof sources === "number")
    parts.push(`${sources} independent source${sources === 1 ? "" : "s"}`);
  if (typeof e.kind === "string") parts.push(`kind ${e.kind}`);
  if (typeof e.domain === "string") parts.push(`domain ${e.domain}`);
  if (typeof e.mx === "string") parts.push(e.mx === "ok" ? "MX found" : `MX ${e.mx}`);
  if (e.domainMatchesWebsite === true) parts.push("matches website domain");
  if (typeof e.httpStatus === "number") parts.push(`HTTP ${e.httpStatus}`);
  if (typeof e.broken === "string" && !parts.some((p) => p.includes(e.broken as string)))
    parts.push(String(e.broken));
  if (e.mock === true) parts.push("MOCK research");
  if (e.previous && typeof e.previous === "object") {
    const p = e.previous as Record<string, unknown>;
    if (typeof p.status === "string") parts.push(`was ${p.status} before override`);
  }
  return parts.join(" · ").slice(0, 240);
}

// ---------- scope ----------

export interface QualScopeLike {
  scopeType: string;
  businessIds: string[];
  discoveryRunId: string | null;
  researchRunId: string | null;
  filter: unknown;
}

export function describeQualificationScope(
  run: QualScopeLike,
  opts: {
    discoveryRunLabel?: (id: string) => string | undefined;
    researchRunLabel?: (id: string) => string | undefined;
    categoryLabel?: (c: string) => string;
  } = {},
): string {
  if (run.scopeType === "businesses")
    return `${run.businessIds.length} selected business${run.businessIds.length === 1 ? "" : "es"}`;
  if (run.scopeType === "discovery_run") {
    const l = run.discoveryRunId ? opts.discoveryRunLabel?.(run.discoveryRunId) : undefined;
    return `Discovery run: ${l ?? run.discoveryRunId?.slice(0, 8) ?? "?"}`;
  }
  if (run.scopeType === "research_run") {
    const l = run.researchRunId ? opts.researchRunLabel?.(run.researchRunId) : undefined;
    return `Research run: ${l ?? run.researchRunId?.slice(0, 8) ?? "?"}`;
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
  if (typeof f.tier === "string") parts.push(`currently ${tierLabel(f.tier).toLowerCase()}`);
  if (typeof f.staleAfterDays === "number")
    parts.push(`not qualified in ${f.staleAfterDays} day${f.staleAfterDays === 1 ? "" : "s"}`);
  if (typeof f.limit === "number") parts.push(`limit ${f.limit}`);
  return `Filter: ${parts.join(", ")}`;
}

// ---------- ranked leads filters ----------

export const LEADS_PAGE_SIZE = 50;

export interface LeadsFilters {
  tier: "" | Tier | "qualified";
  category: string;
}

/** "qualified" = every tier except disqualified (the default ranked view). */
export function parseLeadsFilters(
  sp: Record<string, string | string[] | undefined>,
  isCategory: (c: string) => boolean,
): LeadsFilters {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
  const tier = one(sp.tier);
  const category = one(sp.category);
  return {
    tier: tier === "" ? "qualified" : tier === "all" ? "" : isTier(tier) ? tier : "qualified",
    category: isCategory(category) ? category : "",
  };
}

export function leadsWhere(f: LeadsFilters): Prisma.BusinessWhereInput {
  const where: Prisma.BusinessWhereInput = {
    latestTier:
      f.tier === "qualified"
        ? { in: ["hot", "warm", "cold"] }
        : f.tier === ""
          ? { not: null }
          : f.tier,
  };
  if (f.category) where.category = f.category;
  return where;
}

export function leadsQuery(f: LeadsFilters, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  if (f.tier === "") p.set("tier", "all");
  else if (f.tier !== "qualified") p.set("tier", f.tier);
  if (f.category) p.set("category", f.category);
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const QUALIFICATION_LIMIT_MAX = 1000;
export const QUALIFICATION_DEFAULT_LIMIT = 200;
