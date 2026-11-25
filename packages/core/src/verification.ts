/**
 * Deterministic fact verification (Phase 5). No AI. Rules, documented in docs/DATABASE_SCHEMA.md:
 *
 * - phone / whatsapp: valid E.164; Indian numbers must be +91 and 10 national digits (11 for
 *   1800/1860 toll-free), not starting 0 and not a placeholder. A number is VERIFIED when at least
 *   two INDEPENDENT sources list it (phone and WhatsApp facts both count). Independent means a
 *   different listing provider or a different website host: two pages of one site are one source.
 * - email: syntax, reserved/test domains and disposable domains are INVALID; then an MX lookup
 *   (injected resolver, timeout, cache). Non-existent domain or null MX is INVALID. Mail-capable
 *   domain plus (two independent sources OR domain equal to the business's own website host) is
 *   VERIFIED; otherwise unverified with the evidence recorded.
 * - website: from the latest research of the business: reachable is VERIFIED (https noted),
 *   DNS failure / invalid URL / 404-410 / redirect to a private address is INVALID, transient
 *   failures (timeout, 5xx, TLS, network) and robots-blocked stay unverified.
 * - postcode: Indian PIN format ^[1-9][0-9]{5}$ or INVALID; a PIN outside the listed state's postal
 *   prefixes is CONFLICTING (one of the two is wrong); two independent sources (postcode facts or
 *   a PIN inside an address fact) is VERIFIED. City is not checked (no offline PIN directory).
 * - other conflict fields: the Phase 4 conflict rule, ignoring INVALID values.
 * Facts with a manual override are never changed by this pass.
 */
import { CONFLICT_FIELDS, detectConflicts, factOrigin, type ResearchSourceType } from "./research";
import type { BrokenKind, VerificationStatus, WebsiteSignals } from "./research";

export const VERIFICATION_RULES_VERSION = "verify-v1";

export type VerificationMethod =
  | "phone_format_agreement"
  | "email_syntax_mx"
  | "website_reachability"
  | "postcode_format_state"
  | "conflict_check"
  | "manual";

export interface VerifiableFact {
  id: string;
  field: string;
  value: string;
  normalizedValue: string;
  sourceUrl: string;
  sourceType: string;
  provider: string;
  verificationStatus: string;
  /** Set by a human; the automatic pass leaves it alone. */
  verificationOverride: boolean;
}

export interface LatestResearch {
  id: string;
  status: string; // ok | no_website | broken | blocked | error
  researchedAt: Date;
  signals: WebsiteSignals | null;
  /** Research provider id; "mock-*" results are labelled mock in the evidence. */
  provider?: string;
}

export interface VerificationBusiness {
  id: string;
  state?: string | null;
  city?: string | null;
  website?: string | null;
  rawTags?: unknown;
}

export interface FactVerification {
  factId: string;
  field: string;
  status: VerificationStatus;
  method: VerificationMethod;
  evidence: Record<string, unknown>;
}

// ---------------- DNS / MX ----------------

export type MxLookup =
  | { status: "ok"; exchanges: string[] }
  | { status: "no_mx" } // domain exists, no MX record
  | { status: "null_mx" } // RFC 7505: domain says it accepts no mail
  | { status: "nxdomain" }
  | { status: "timeout" }
  | { status: "error"; error: string };

export interface MxResolver {
  lookup(domain: string): Promise<MxLookup>;
  /** Network lookups actually made (cache hits excluded). */
  readonly lookups?: number;
}

// ---------------- phone ----------------

export type PhoneKind = "mobile" | "landline" | "mobile_or_landline" | "toll_free" | "foreign";

export interface PhoneCheck {
  valid: boolean;
  kind?: PhoneKind;
  reason?: string;
}

const PLACEHOLDER_NATIONAL = new Set(["1234567890", "9876543210", "0123456789", "1234512345"]);

/** Format check for an E.164 number, with Indian numbering rules for +91. */
export function checkPhone(e164: string): PhoneCheck {
  if (!/^\+[1-9]\d{6,14}$/.test(e164)) return { valid: false, reason: "not an E.164 number" };
  if (!e164.startsWith("+91")) return { valid: true, kind: "foreign" };
  const n = e164.slice(3);
  if (n.startsWith("0")) return { valid: false, reason: "Indian national number cannot start 0" };
  const tollFree = /^(1800|1860)/.test(n);
  if (tollFree ? n.length !== 10 && n.length !== 11 : n.length !== 10)
    return {
      valid: false,
      reason: `Indian number must have 10 digits after +91 (has ${n.length})`,
    };
  if (/^(\d)\1+$/.test(n) || PLACEHOLDER_NATIONAL.has(n))
    return { valid: false, reason: "placeholder number" };
  if (tollFree) return { valid: true, kind: "toll_free" };
  const d = n[0]!;
  if (d === "6" || d === "7" || d === "9") return { valid: true, kind: "mobile" };
  // 8x is both a mobile series and the Bengaluru (080) landline code.
  if (d === "8") return { valid: true, kind: "mobile_or_landline" };
  return { valid: true, kind: "landline" };
}

// ---------------- email ----------------

/** Common disposable / throwaway mail domains. Not exhaustive; extend via config later. */
export const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "10minutemail.com",
  "20minutemail.com",
  "33mail.com",
  "discard.email",
  "dispostable.com",
  "emailondeck.com",
  "fakeinbox.com",
  "getairmail.com",
  "getnada.com",
  "guerrillamail.com",
  "guerrillamail.net",
  "guerrillamailblock.com",
  "harakirimail.com",
  "inboxkitten.com",
  "maildrop.cc",
  "mailinator.com",
  "mailinator.net",
  "mailnesia.com",
  "mintemail.com",
  "mohmal.com",
  "moakt.com",
  "mytemp.email",
  "sharklasers.com",
  "spamgourmet.com",
  "temp-mail.org",
  "tempail.com",
  "tempmail.com",
  "tempmail.net",
  "tempmailo.com",
  "tempr.email",
  "throwawaymail.com",
  "trashmail.com",
  "trashmail.de",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
]);

/** Large consumer mail providers: valid, common for small Indian businesses, noted only. */
export const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "yahoo.com",
  "yahoo.co.in",
  "yahoo.in",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "rediffmail.com",
  "icloud.com",
  "protonmail.com",
  "proton.me",
  "zoho.com",
  "aol.com",
]);

const RESERVED_TLDS = new Set(["invalid", "test", "example", "localhost", "local", "internal"]);
const RESERVED_DOMAINS = new Set(["example.com", "example.net", "example.org"]);
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const EMAIL_RE = new RegExp(
  `^([a-z0-9!#$%&'*+/=?^_\`{|}~-]+(?:\\.[a-z0-9!#$%&'*+/=?^_\`{|}~-]+)*)@((?:${LABEL}\\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59}))$`,
  "i",
);

export interface EmailSyntaxCheck {
  valid: boolean;
  domain?: string;
  reason?: string;
  disposable?: boolean;
  freemail?: boolean;
}

export function checkEmailSyntax(email: string): EmailSyntaxCheck {
  const e = email.trim().toLowerCase();
  if (e.length > 254) return { valid: false, reason: "address longer than 254 characters" };
  const m = e.match(EMAIL_RE);
  if (!m) return { valid: false, reason: "not a valid email address" };
  const local = m[1]!;
  const domain = m[2]!;
  if (local.length > 64) return { valid: false, domain, reason: "local part over 64 characters" };
  const tld = domain.split(".").pop()!;
  if (RESERVED_TLDS.has(tld) || RESERVED_DOMAINS.has(domain) || domain.endsWith(".example.com"))
    return { valid: false, domain, reason: "reserved or test domain" };
  if (DISPOSABLE_EMAIL_DOMAINS.has(domain))
    return { valid: false, domain, reason: "disposable email domain", disposable: true };
  return { valid: true, domain, freemail: FREEMAIL_DOMAINS.has(domain) };
}

// ---------------- postcode ----------------

/**
 * Two- or three-digit PIN prefixes per state / union territory (postal circles). Approximate:
 * borders and shared circles (Telangana/Andhra, Bihar/Jharkhand, North East) overlap on purpose.
 */
export const STATE_PIN_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  delhi: ["11"],
  haryana: ["12", "13"],
  punjab: ["14", "15", "16"],
  chandigarh: ["16"],
  "himachal pradesh": ["17"],
  "jammu and kashmir": ["18", "19"],
  ladakh: ["19"],
  "uttar pradesh": ["20", "21", "22", "23", "24", "25", "26", "27", "28"],
  uttarakhand: ["24", "26"],
  rajasthan: ["30", "31", "32", "33", "34"],
  gujarat: ["36", "37", "38", "39"],
  "dadra and nagar haveli and daman and diu": ["396"],
  maharashtra: ["40", "41", "42", "43", "44"],
  goa: ["403"],
  "madhya pradesh": ["45", "46", "47", "48"],
  chhattisgarh: ["49"],
  telangana: ["50"],
  "andhra pradesh": ["50", "51", "52", "53"],
  karnataka: ["56", "57", "58", "59"],
  "tamil nadu": ["60", "61", "62", "63", "64"],
  puducherry: ["533", "605", "607", "609", "673"],
  kerala: ["67", "68", "69"],
  lakshadweep: ["682"],
  "west bengal": ["70", "71", "72", "73", "74"],
  sikkim: ["737"],
  "andaman and nicobar islands": ["744"],
  odisha: ["75", "76", "77"],
  assam: ["78"],
  "arunachal pradesh": ["79"],
  nagaland: ["79"],
  manipur: ["79"],
  mizoram: ["79"],
  tripura: ["79"],
  meghalaya: ["79"],
  bihar: ["80", "81", "82", "84", "85"],
  jharkhand: ["81", "82", "83", "84"],
};

const STATE_ALIASES: Record<string, string> = {
  "nct of delhi": "delhi",
  "new delhi": "delhi",
  orissa: "odisha",
  pondicherry: "puducherry",
  "j&k": "jammu and kashmir",
  "jammu & kashmir": "jammu and kashmir",
  ka: "karnataka",
  kar: "karnataka",
  mh: "maharashtra",
  tn: "tamil nadu",
  kl: "kerala",
  ap: "andhra pradesh",
  ts: "telangana",
  tg: "telangana",
  up: "uttar pradesh",
  wb: "west bengal",
};

export function normalizeState(state: string | null | undefined): string | null {
  if (!state) return null;
  const s = state.trim().toLowerCase().replace(/\s+/g, " ");
  const k = STATE_ALIASES[s] ?? s;
  return STATE_PIN_PREFIXES[k] ? k : null;
}

export const PIN_RE = /^[1-9][0-9]{5}$/;

export interface PinCheck {
  valid: boolean;
  reason?: string;
  /** null when the state is unknown or not recognised. */
  stateMatch: boolean | null;
  state?: string;
}

export function checkPin(pin: string, state?: string | null): PinCheck {
  const p = pin.replace(/\s+/g, "");
  if (!PIN_RE.test(p))
    return { valid: false, reason: "Indian PIN must be 6 digits not starting 0", stateMatch: null };
  const st = normalizeState(state);
  if (!st) return { valid: true, stateMatch: null };
  const prefixes = STATE_PIN_PREFIXES[st]!;
  return { valid: true, stateMatch: prefixes.some((x) => p.startsWith(x)), state: st };
}

/** 6-digit PINs inside free text (addresses). */
export function pinsInText(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/(?<!\d)([1-9]\d{2})\s?(\d{3})(?!\d)/g)].map((m) => m[1]! + m[2]!),
    ),
  ];
}

// ---------------- independence ----------------

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Identity of a source for agreement counting. Listing records: one per discovery provider.
 * Websites: one per host (homepage, contact page and JSON-LD of one site are one source).
 */
export function sourceKey(f: Pick<VerifiableFact, "sourceType" | "sourceUrl" | "provider">) {
  if (factOrigin(f.sourceType as ResearchSourceType) === "listing") return `listing:${f.provider}`;
  return `site:${hostOf(f.sourceUrl) ?? f.sourceUrl}`;
}

// ---------------- operating status ----------------

export type OperatingStatus = "closed" | "possibly_closed" | "no_evidence";

export interface OperatingHint {
  code: "osm_lifecycle_tag" | "osm_closed_tag" | "osm_end_date" | "website_gone";
  detail: string;
  strength: "strong" | "weak";
}

export interface OperatingAssessment {
  status: OperatingStatus;
  hints: OperatingHint[];
}

const LIFECYCLE_PREFIXES = ["disused:", "was:", "abandoned:", "demolished:", "removed:", "razed:"];
const GONE_KINDS: readonly BrokenKind[] = ["dns", "invalid_url"];

/** "Still operating" hints from OSM tags and the latest website research. */
export function assessOperating(
  rawTags: unknown,
  research: LatestResearch | null,
  now = new Date(),
): OperatingAssessment {
  const hints: OperatingHint[] = [];
  const tags =
    rawTags && typeof rawTags === "object" && !Array.isArray(rawTags)
      ? (rawTags as Record<string, unknown>)
      : {};
  for (const [k, v] of Object.entries(tags)) {
    const val = typeof v === "string" ? v.trim().toLowerCase() : "";
    if (LIFECYCLE_PREFIXES.some((p) => k.startsWith(p)))
      hints.push({
        code: "osm_lifecycle_tag",
        detail: `OSM tag ${k}=${String(v)}`,
        strength: "strong",
      });
    else if (
      ((k === "disused" || k === "abandoned" || k === "closed") && val === "yes") ||
      ((k === "shop" || k === "amenity") && val === "vacant") ||
      (k === "opening_hours" && (val === "closed" || val === "off")) ||
      ((k === "status" || k === "operational_status") &&
        /closed|defunct|abandoned|disused/.test(val))
    )
      hints.push({
        code: "osm_closed_tag",
        detail: `OSM tag ${k}=${String(v)}`,
        strength: "strong",
      });
    else if (k === "end_date" && val) {
      const m = val.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
      if (m) {
        const end = new Date(Date.UTC(+m[1]!, m[2] ? +m[2] - 1 : 11, m[3] ? +m[3] : 28));
        if (end.getTime() < now.getTime())
          hints.push({
            code: "osm_end_date",
            detail: `OSM end_date=${String(v)}`,
            strength: "strong",
          });
      }
    }
  }
  const s = research?.signals;
  if (research?.status === "broken" && s?.broken) {
    const gone =
      GONE_KINDS.includes(s.broken) ||
      (s.broken === "http_4xx" && (s.httpStatus === 404 || s.httpStatus === 410));
    if (gone)
      hints.push({
        code: "website_gone",
        detail:
          `Website ${s.requestedUrl ?? ""} ${s.broken === "dns" ? "domain does not resolve" : `returned ${s.httpStatus ?? s.broken}`}`.replace(
            /\s+/g,
            " ",
          ),
        strength: "weak",
      });
  }
  const status: OperatingStatus = hints.some((h) => h.strength === "strong")
    ? "closed"
    : hints.length
      ? "possibly_closed"
      : "no_evidence";
  return { status, hints };
}

// ---------------- the pass ----------------

export interface VerifyInput {
  business: VerificationBusiness;
  facts: VerifiableFact[];
  latestResearch: LatestResearch | null;
}

export interface VerificationSummary {
  rulesVersion: string;
  checked: number;
  verified: number;
  invalid: number;
  conflicting: number;
  unverified: number;
  manual: number;
  mxLookups: number;
}

export interface VerificationOutcome {
  /** One entry per automatically checked fact (manual overrides excluded). */
  facts: FactVerification[];
  summary: VerificationSummary;
  operating: OperatingAssessment;
}

const NUMBER_FIELDS = new Set(["phone", "whatsapp"]);
const INVALID_WEBSITE_KINDS: readonly BrokenKind[] = ["dns", "invalid_url", "ssrf_blocked"];

interface Draft {
  status: VerificationStatus;
  method: VerificationMethod;
  evidence: Record<string, unknown>;
}

export async function verifyBusinessFacts(
  input: VerifyInput,
  deps: { mx: MxResolver; now?: Date },
): Promise<VerificationOutcome> {
  const now = deps.now ?? new Date();
  const { business, facts, latestResearch } = input;
  const auto = facts.filter((f) => !f.verificationOverride);
  const manualInvalid = new Set(
    facts
      .filter((f) => f.verificationOverride && f.verificationStatus === "invalid")
      .map((f) => f.id),
  );
  const usable = facts.filter((f) => !manualInvalid.has(f.id));
  const drafts = new Map<string, Draft>();
  let mxLookups = 0;

  // numbers: format + agreement across phone and whatsapp facts
  const numberSources = new Map<string, { keys: Set<string>; ids: string[] }>();
  for (const f of usable)
    if (NUMBER_FIELDS.has(f.field) && checkPhone(f.normalizedValue).valid) {
      const g = numberSources.get(f.normalizedValue) ?? { keys: new Set(), ids: [] };
      g.keys.add(sourceKey(f));
      g.ids.push(f.id);
      numberSources.set(f.normalizedValue, g);
    }
  for (const f of auto.filter((x) => NUMBER_FIELDS.has(x.field))) {
    const c = checkPhone(f.normalizedValue);
    if (!c.valid) {
      drafts.set(f.id, {
        status: "invalid",
        method: "phone_format_agreement",
        evidence: { reason: c.reason },
      });
      continue;
    }
    const g = numberSources.get(f.normalizedValue)!;
    const sources = [...g.keys].sort();
    drafts.set(f.id, {
      status: sources.length >= 2 ? "verified" : "unverified",
      method: "phone_format_agreement",
      evidence: {
        kind: c.kind,
        independentSources: sources,
        agreeingFactIds: g.ids.filter((id) => id !== f.id),
        ...(sources.length < 2 ? { reason: "only one independent source lists this number" } : {}),
      },
    });
  }

  // email
  const ownHosts = new Set(
    [business.website, latestResearch?.signals?.finalUrl, latestResearch?.signals?.requestedUrl]
      .map(hostOf)
      .filter((h): h is string => Boolean(h)),
  );
  const emailSources = new Map<string, Set<string>>();
  for (const f of usable.filter((x) => x.field === "email")) {
    const s = emailSources.get(f.normalizedValue) ?? new Set();
    s.add(sourceKey(f));
    emailSources.set(f.normalizedValue, s);
  }
  const mxByDomain = new Map<string, MxLookup>();
  for (const f of auto.filter((x) => x.field === "email")) {
    const syn = checkEmailSyntax(f.normalizedValue);
    if (!syn.valid) {
      drafts.set(f.id, {
        status: "invalid",
        method: "email_syntax_mx",
        evidence: { reason: syn.reason, domain: syn.domain },
      });
      continue;
    }
    const domain = syn.domain!;
    let mx = mxByDomain.get(domain);
    if (!mx) {
      mx = await deps.mx.lookup(domain);
      mxByDomain.set(domain, mx);
      mxLookups++;
    }
    const sources = [...(emailSources.get(f.normalizedValue) ?? [])].sort();
    const domainMatchesWebsite = [...ownHosts].some(
      (h) => h === domain || h.endsWith(`.${domain}`),
    );
    const evidence: Record<string, unknown> = {
      domain,
      mx: mx.status,
      ...(mx.status === "ok" ? { mxHosts: mx.exchanges.slice(0, 3) } : {}),
      freemail: Boolean(syn.freemail),
      independentSources: sources,
      domainMatchesWebsite,
    };
    let status: VerificationStatus = "unverified";
    if (mx.status === "nxdomain") {
      status = "invalid";
      evidence.reason = "email domain does not exist";
    } else if (mx.status === "null_mx") {
      status = "invalid";
      evidence.reason = "email domain publishes a null MX (accepts no mail)";
    } else if (mx.status === "ok" && (sources.length >= 2 || domainMatchesWebsite)) {
      status = "verified";
    } else if (mx.status === "ok") {
      evidence.reason = "mail domain is valid but only one independent source lists the address";
    } else {
      evidence.reason =
        mx.status === "no_mx"
          ? "domain has no MX record"
          : `MX lookup ${mx.status === "timeout" ? "timed out" : "failed"}; retried next run`;
    }
    drafts.set(f.id, { status, method: "email_syntax_mx", evidence });
  }

  // website
  const sig = latestResearch?.signals ?? null;
  const researchedHosts = new Set(
    [sig?.requestedUrl, sig?.finalUrl].map(hostOf).filter((h): h is string => Boolean(h)),
  );
  for (const f of auto.filter((x) => x.field === "website")) {
    const h = hostOf(f.normalizedValue) ?? hostOf(f.value);
    const base = { method: "website_reachability" as const };
    if (!latestResearch || !sig || !h || !researchedHosts.has(h)) {
      drafts.set(f.id, {
        ...base,
        status: "unverified",
        evidence: {
          reason: latestResearch ? "not the URL researched" : "website not researched yet",
        },
      });
      continue;
    }
    const ev: Record<string, unknown> = {
      researchId: latestResearch.id,
      researchedAt: latestResearch.researchedAt.toISOString(),
      httpStatus: sig.httpStatus ?? null,
      https: sig.https ?? null,
      finalUrl: sig.finalUrl ?? null,
      ...(latestResearch.provider?.startsWith("mock-") ? { mock: true } : {}),
    };
    if (latestResearch.status === "ok") {
      drafts.set(f.id, { ...base, status: "verified", evidence: ev });
    } else if (latestResearch.status === "blocked") {
      drafts.set(f.id, {
        ...base,
        status: "unverified",
        evidence: { ...ev, reason: "robots.txt disallows checking this site" },
      });
    } else if (latestResearch.status === "broken" && sig.broken) {
      const permanent =
        INVALID_WEBSITE_KINDS.includes(sig.broken) ||
        (sig.broken === "http_4xx" && (sig.httpStatus === 404 || sig.httpStatus === 410));
      drafts.set(f.id, {
        ...base,
        status: permanent ? "invalid" : "unverified",
        evidence: { ...ev, broken: sig.broken, reason: sig.brokenDetail ?? sig.broken },
      });
    } else {
      drafts.set(f.id, {
        ...base,
        status: "unverified",
        evidence: { ...ev, reason: `research status ${latestResearch.status}` },
      });
    }
  }

  // postcode (+ PINs inside addresses as corroboration)
  const pinSources = new Map<string, Set<string>>();
  const addPin = (pin: string, key: string) => {
    const s = pinSources.get(pin) ?? new Set();
    s.add(key);
    pinSources.set(pin, s);
  };
  for (const f of usable) {
    if (f.field === "postcode") addPin(f.normalizedValue.replace(/\s+/g, ""), sourceKey(f));
    if (f.field === "address") for (const p of pinsInText(f.value)) addPin(p, sourceKey(f));
  }
  for (const f of auto.filter((x) => x.field === "postcode")) {
    const pin = f.normalizedValue.replace(/\s+/g, "");
    const c = checkPin(pin, business.state);
    const base = { method: "postcode_format_state" as const };
    if (!c.valid) {
      drafts.set(f.id, { ...base, status: "invalid", evidence: { reason: c.reason } });
      continue;
    }
    const sources = [...(pinSources.get(pin) ?? [])].sort();
    const ev = {
      stateMatch: c.stateMatch,
      state: c.state ?? business.state ?? null,
      cityChecked: false,
      independentSources: sources,
    };
    if (c.stateMatch === false)
      drafts.set(f.id, {
        ...base,
        status: "conflicting",
        evidence: { ...ev, reason: `PIN ${pin} is outside ${business.state}'s postal prefixes` },
      });
    else
      drafts.set(f.id, {
        ...base,
        status: sources.length >= 2 ? "verified" : "unverified",
        evidence: sources.length >= 2 ? ev : { ...ev, reason: "only one independent source" },
      });
  }

  // Phase 4 conflict rule, without invalid values; applies to values not verified/invalid above.
  const conflictInput = usable.filter(
    (f) =>
      (CONFLICT_FIELDS as readonly string[]).includes(f.field) &&
      (drafts.get(f.id)?.status ?? f.verificationStatus) !== "invalid",
  );
  const conflicting = detectConflicts(conflictInput);
  for (const f of auto) {
    if (!(CONFLICT_FIELDS as readonly string[]).includes(f.field)) continue;
    const d = drafts.get(f.id);
    if (d && (d.status === "verified" || d.status === "invalid" || d.status === "conflicting"))
      continue;
    if (conflicting.has(f.field))
      drafts.set(f.id, {
        status: "conflicting",
        method: d?.method ?? "conflict_check",
        evidence: {
          ...(d?.evidence ?? {}),
          reason: "listing and website give different values for this field",
        },
      });
    else if (!d) drafts.set(f.id, { status: "unverified", method: "conflict_check", evidence: {} });
  }

  const out: FactVerification[] = [];
  for (const f of auto) {
    const d = drafts.get(f.id);
    if (!d) continue;
    out.push({
      factId: f.id,
      field: f.field,
      status: d.status,
      method: d.method,
      evidence: { rulesVersion: VERIFICATION_RULES_VERSION, ...d.evidence },
    });
  }
  const count = (s: VerificationStatus) => out.filter((x) => x.status === s).length;
  return {
    facts: out,
    summary: {
      rulesVersion: VERIFICATION_RULES_VERSION,
      checked: out.length,
      verified: count("verified"),
      invalid: count("invalid"),
      conflicting: count("conflicting"),
      unverified: count("unverified"),
      manual: facts.length - auto.length,
      mxLookups,
    },
    operating: assessOperating(business.rawTags, latestResearch, now),
  };
}

/** The statuses a person may set by manual override. */
export const MANUAL_OVERRIDE_STATUSES: readonly VerificationStatus[] = [
  "verified",
  "unverified",
  "conflicting",
  "invalid",
];
