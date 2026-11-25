/**
 * Lead qualification (Phase 5). The rules scorer works with no AI at all and is the only thing
 * that sets a business's score and tier. The optional AI step adds a summary, a pitch angle and
 * risk flags, stored separately: it never changes the score.
 *
 * Score (0-100) = website opportunity (max 50) + contactability (max 35) + category fit (max 15).
 * Every reason names the fact ids (and research id) it rests on.
 */
import { z } from "zod";
import type { OperatingAssessment } from "./verification";
import type { WebsiteSignals } from "./research";
import { checkEmailSyntax, checkPhone } from "./verification";

export const QUALIFICATION_RULES_VERSION = "rules-v1";
export const QUALIFICATION_TIERS = ["hot", "warm", "cold", "disqualified"] as const;
export type QualificationTier = (typeof QUALIFICATION_TIERS)[number];

export const QUALIFICATION_SCOPE_TYPES = [
  "businesses",
  "discovery_run",
  "research_run",
  "filter",
] as const;
export type QualificationScopeType = (typeof QUALIFICATION_SCOPE_TYPES)[number];
export const QUALIFICATION_MAX_BUSINESSES_PER_RUN = 1000;

export const QUALIFICATION_AI_PROVIDERS = ["none", "mock", "ollama", "gemini"] as const;
export type QualificationAiProvider = (typeof QUALIFICATION_AI_PROVIDERS)[number];

// ---------------- config ----------------

/** Defaults are rules, not prices. Owner overrides live in system_setting key "qualification". */
export const qualificationConfigSchema = z.object({
  website: z
    .object({
      noWebsite: z.number().min(0).max(100).default(50),
      socialProfileOnly: z.number().min(0).max(100).default(45),
      broken: z.number().min(0).max(100).default(45),
      noHttps: z.number().min(0).max(100).default(12),
      notMobileFriendly: z.number().min(0).max(100).default(12),
      outdatedCopyright: z.number().min(0).max(100).default(8),
      oldBuilder: z.number().min(0).max(100).default(8),
      missingBasics: z.number().min(0).max(100).default(5),
      slow: z.number().min(0).max(100).default(5),
      max: z.number().min(0).max(100).default(50),
    })
    .prefault({}),
  contact: z
    .object({
      verifiedPhone: z.number().min(0).max(100).default(20),
      phone: z.number().min(0).max(100).default(10),
      verifiedWhatsapp: z.number().min(0).max(100).default(10),
      whatsapp: z.number().min(0).max(100).default(5),
      verifiedEmail: z.number().min(0).max(100).default(10),
      email: z.number().min(0).max(100).default(4),
      max: z.number().min(0).max(100).default(35),
    })
    .prefault({}),
  categoryMax: z.number().min(0).max(100).default(15),
  categoryFit: z.record(z.string(), z.number().min(0).max(1)).default({
    restaurants: 1,
    clinics: 1,
    hotels: 0.9,
    real_estate: 0.9,
    professional_services: 0.9,
    education: 0.8,
    garages: 0.8,
    automobile: 0.8,
    retail: 0.8,
    hospitals: 0.7,
    supermarkets: 0.6,
    manufacturers: 0.6,
  }),
  defaultCategoryFit: z.number().min(0).max(1).default(0.5),
  /** Owner-blocklisted categories: always disqualified. */
  blockedCategories: z.array(z.string()).default([]),
  thresholds: z
    .object({
      hot: z.number().int().min(1).max(100).default(70),
      warm: z.number().int().min(1).max(100).default(45),
    })
    .prefault({})
    .refine((t) => t.warm < t.hot, "warm threshold must be below hot"),
  /** Site builders treated as dated (tech hint names from research signals). */
  oldBuilders: z
    .array(z.string())
    .default(["Blogger", "Weebly", "GoDaddy Website Builder", "Google Sites", "Joomla"]),
  /** Copyright year this many years (or more) behind the current year counts as outdated. */
  outdatedCopyrightYears: z.number().int().min(1).max(20).default(2),
  slowResponseMs: z.number().int().min(500).max(60_000).default(4000),
});
export type QualificationConfig = z.infer<typeof qualificationConfigSchema>;

export function parseQualificationConfig(input: unknown): QualificationConfig {
  return qualificationConfigSchema.parse(input ?? {});
}

// ---------------- input / output ----------------

export interface ScoringFact {
  id: string;
  field: string;
  normalizedValue: string;
  sourceType: string;
  verificationStatus: string;
}

export interface ScoringInput {
  business: { id: string; name: string; category: string; source?: string | null };
  facts: ScoringFact[];
  latestResearch: { id: string; status: string; signals: WebsiteSignals | null } | null;
  operating: OperatingAssessment;
  /** Older business this one duplicates (same name nearby / same verified number), if any. */
  duplicateOfId?: string | null;
  now?: Date;
}

export type ReasonKind = "opportunity" | "contact" | "category" | "disqualification" | "note";

export interface QualificationReason {
  code: string;
  kind: ReasonKind;
  points: number;
  text: string;
  /** research_fact ids the reason rests on. Empty only for absence ("no website listed"). */
  factIds: string[];
  researchId?: string;
}

export const DISQUALIFICATION_CODES = [
  "closed",
  "no_contact_channel",
  "duplicate",
  "blocked_category",
] as const;
export type DisqualificationCode = (typeof DISQUALIFICATION_CODES)[number];

export interface QualificationScore {
  rulesVersion: string;
  score: number;
  tier: QualificationTier;
  components: { website: number; contact: number; category: number };
  reasons: QualificationReason[];
  disqualifiedReason: DisqualificationCode | null;
  /** True when any input is MOCK data: never a real lead. */
  mock: boolean;
}

const USABLE = new Set(["verified", "unverified", "conflicting"]);

function pickContact(facts: ScoringFact[], field: "phone" | "whatsapp" | "email") {
  const ok = facts.filter(
    (f) =>
      f.field === field &&
      USABLE.has(f.verificationStatus) &&
      (field === "email"
        ? checkEmailSyntax(f.normalizedValue).valid
        : checkPhone(f.normalizedValue).valid),
  );
  const verified = ok.filter((f) => f.verificationStatus === "verified");
  return { ok, verified };
}

const ids = (fs: { id: string }[]) => [...new Set(fs.map((f) => f.id))];

export function scoreBusiness(
  input: ScoringInput,
  config: QualificationConfig,
): QualificationScore {
  const now = input.now ?? new Date();
  const { business, facts, latestResearch } = input;
  const reasons: QualificationReason[] = [];
  const websiteFacts = facts.filter((f) => f.field === "website");
  const websiteIds = ids(websiteFacts);
  const researchId = latestResearch?.id;
  const sig = latestResearch?.signals ?? null;
  const W = config.website;

  // --- website opportunity ---
  let website = 0;
  const add = (r: QualificationReason) => {
    reasons.push(r);
    return r.points;
  };
  if (!latestResearch) {
    if (!websiteFacts.length && !facts.some((f) => f.field.startsWith("social_")))
      website += add({
        code: "no_website",
        kind: "opportunity",
        points: W.noWebsite,
        text: "No website listed in any source.",
        factIds: [],
      });
    else
      reasons.push({
        code: "website_not_researched",
        kind: "note",
        points: 0,
        text: "A website is listed but has not been researched yet, so its quality is unknown.",
        factIds: websiteIds,
      });
  } else if (latestResearch.status === "no_website" || sig?.noWebsite) {
    if (sig?.socialProfileOnly)
      website += add({
        code: "social_profile_only",
        kind: "opportunity",
        points: W.socialProfileOnly,
        text: `Only a ${sig.socialProfileOnly} profile is listed, no own website.`,
        factIds: websiteIds,
        researchId,
      });
    else
      website += add({
        code: "no_website",
        kind: "opportunity",
        points: W.noWebsite,
        text: "No website listed in any source.",
        factIds: [],
        researchId,
      });
  } else if (latestResearch.status === "broken") {
    website += add({
      code: "website_broken",
      kind: "opportunity",
      points: W.broken,
      text: `The listed website does not work (${sig?.brokenDetail ?? sig?.broken ?? "unreachable"}).`,
      factIds: websiteIds,
      researchId,
    });
  } else if (latestResearch.status === "ok" && sig) {
    if (sig.https === false)
      website += add({
        code: "no_https",
        kind: "opportunity",
        points: W.noHttps,
        text: "The website is served over plain HTTP, without a secure (https) connection.",
        factIds: websiteIds,
        researchId,
      });
    if (sig.hasViewport === false)
      website += add({
        code: "not_mobile_friendly",
        kind: "opportunity",
        points: W.notMobileFriendly,
        text: "The website has no mobile viewport setting, so it is likely hard to use on phones.",
        factIds: websiteIds,
        researchId,
      });
    if (sig.copyrightYear && now.getFullYear() - sig.copyrightYear >= config.outdatedCopyrightYears)
      website += add({
        code: "outdated_copyright",
        kind: "opportunity",
        points: W.outdatedCopyright,
        text: `The footer copyright says ${sig.copyrightYear}, suggesting the site is not maintained.`,
        factIds: websiteIds,
        researchId,
      });
    const old = (sig.tech ?? []).filter((t) => config.oldBuilders.includes(t));
    if (old.length)
      website += add({
        code: "old_builder",
        kind: "opportunity",
        points: W.oldBuilder,
        text: `Built with ${old.join(", ")}, an older site builder.`,
        factIds: websiteIds,
        researchId,
      });
    if (sig.hasTitle === false || sig.hasMetaDescription === false)
      website += add({
        code: "missing_basics",
        kind: "opportunity",
        points: W.missingBasics,
        text: `The homepage is missing a ${[sig.hasTitle === false ? "title" : "", sig.hasMetaDescription === false ? "search description" : ""].filter(Boolean).join(" and ")}.`,
        factIds: websiteIds,
        researchId,
      });
    if (sig.responseTimeMs && sig.responseTimeMs > config.slowResponseMs)
      website += add({
        code: "slow",
        kind: "opportunity",
        points: W.slow,
        text: `The homepage took ${(sig.responseTimeMs / 1000).toFixed(1)} s to respond.`,
        factIds: websiteIds,
        researchId,
      });
    if (website === 0)
      reasons.push({
        code: "website_ok",
        kind: "note",
        points: 0,
        text: "The website looks reasonably current (https, mobile viewport, no dated builder).",
        factIds: websiteIds,
        researchId,
      });
  } else {
    reasons.push({
      code: "website_unchecked",
      kind: "note",
      points: 0,
      text:
        latestResearch.status === "blocked"
          ? "The website's robots.txt does not allow checking it, so its quality is unknown."
          : "The website could not be assessed in the latest research.",
      factIds: websiteIds,
      researchId,
    });
  }
  website = Math.min(website, W.max);

  // --- contactability ---
  const C = config.contact;
  let contact = 0;
  const phone = pickContact(facts, "phone");
  const wa = pickContact(facts, "whatsapp");
  const email = pickContact(facts, "email");
  const contactReason = (
    code: string,
    label: string,
    g: ReturnType<typeof pickContact>,
    verifiedPts: number,
    pts: number,
  ) => {
    if (g.verified.length)
      contact += add({
        code: `verified_${code}`,
        kind: "contact",
        points: verifiedPts,
        text: `${label} confirmed by two independent sources${code === "email" ? " (mail domain checked)" : ""}.`,
        factIds: ids(g.verified),
      });
    else if (g.ok.length)
      contact += add({
        code,
        kind: "contact",
        points: pts,
        text: `${label} found but not independently confirmed${g.ok.some((f) => f.verificationStatus === "conflicting") ? " (sources disagree)" : ""}.`,
        factIds: ids(g.ok),
      });
  };
  contactReason("phone", "Phone number", phone, C.verifiedPhone, C.phone);
  contactReason("whatsapp", "WhatsApp number", wa, C.verifiedWhatsapp, C.whatsapp);
  contactReason("email", "Email address", email, C.verifiedEmail, C.email);
  contact = Math.min(contact, C.max);
  const invalidContacts = facts.filter(
    (f) => ["phone", "whatsapp", "email"].includes(f.field) && f.verificationStatus === "invalid",
  );
  if (invalidContacts.length)
    reasons.push({
      code: "invalid_contacts",
      kind: "note",
      points: 0,
      text: `${invalidContacts.length} contact value(s) failed verification and were ignored.`,
      factIds: ids(invalidContacts),
    });

  // --- category fit ---
  const fit = config.categoryFit[business.category] ?? config.defaultCategoryFit;
  const category = Math.round(fit * config.categoryMax);
  reasons.push({
    code: "category_fit",
    kind: "category",
    points: category,
    text: `Category "${business.category}" fit ${Math.round(fit * 100)}% for website services.`,
    factIds: [],
  });

  // --- disqualification (first match wins, in this order) ---
  let disq: DisqualificationCode | null = null;
  const op = input.operating;
  if (op.status === "closed") {
    disq = "closed";
    reasons.push({
      code: "dq_closed",
      kind: "disqualification",
      points: 0,
      text: `Marked closed or disused: ${op.hints
        .filter((h) => h.strength === "strong")
        .map((h) => h.detail)
        .join("; ")}.`,
      factIds: [],
    });
  } else if (op.status === "possibly_closed")
    reasons.push({
      code: "possibly_closed",
      kind: "note",
      points: 0,
      text: `May have closed: ${op.hints.map((h) => h.detail).join("; ")}. Check before contacting.`,
      factIds: websiteIds,
      researchId,
    });
  if (!disq && config.blockedCategories.includes(business.category)) {
    disq = "blocked_category";
    reasons.push({
      code: "dq_blocked_category",
      kind: "disqualification",
      points: 0,
      text: `Category "${business.category}" is on the owner's blocklist.`,
      factIds: [],
    });
  }
  if (!disq && input.duplicateOfId) {
    disq = "duplicate";
    reasons.push({
      code: "dq_duplicate",
      kind: "disqualification",
      points: 0,
      text: `Duplicate of an earlier business record (${input.duplicateOfId}).`,
      factIds: [],
    });
  }
  if (!disq && !phone.ok.length && !wa.ok.length && !email.ok.length) {
    disq = "no_contact_channel";
    reasons.push({
      code: "dq_no_contact_channel",
      kind: "disqualification",
      points: 0,
      text: "No usable phone, WhatsApp or email in any source.",
      factIds: ids(invalidContacts),
    });
  }

  const mock =
    business.source === "mock" ||
    facts.some((f) => f.sourceType === "mock") ||
    business.name.startsWith("MOCK");
  if (mock)
    reasons.push({
      code: "mock_data",
      kind: "note",
      points: 0,
      text: "MOCK test data: not a real business.",
      factIds: ids(facts.filter((f) => f.sourceType === "mock")),
    });

  const score = Math.max(0, Math.min(100, Math.round(website + contact + category)));
  const tier: QualificationTier = disq
    ? "disqualified"
    : score >= config.thresholds.hot
      ? "hot"
      : score >= config.thresholds.warm
        ? "warm"
        : "cold";
  return {
    rulesVersion: QUALIFICATION_RULES_VERSION,
    score,
    tier,
    components: { website, contact, category },
    reasons,
    disqualifiedReason: disq,
    mock,
  };
}

// ---------------- optional AI step ----------------

export const AI_RISK_CODES = [
  "contact_unverified",
  "conflicting_data",
  "possibly_closed",
  "sparse_data",
  "personal_data",
  "chain_or_franchise",
  "other",
] as const;

export const qualificationAiOutputSchema = z.object({
  summary: z.string().trim().min(1).max(600),
  pitchAngle: z.string().trim().min(1).max(400),
  riskFlags: z
    .array(
      z.object({
        code: z.enum(AI_RISK_CODES),
        text: z.string().trim().min(1).max(300),
        factIds: z.array(z.string()).max(10).default([]),
      }),
    )
    .max(8)
    .default([]),
});
export type QualificationAiOutput = z.infer<typeof qualificationAiOutputSchema>;

export interface AiPromptFact {
  id: string;
  field: string;
  value: string;
  sourceType: string;
  verificationStatus: string;
}

const CONTACT_FIELDS = new Set(["phone", "whatsapp", "email"]);

/**
 * Builds the qualification prompt from the business's own sourced facts and research signals
 * only (no browsing). Contact values are masked: the model learns that a verified phone exists,
 * never the number or address, so no personal data reaches a hosted model.
 */
export function buildQualificationPrompt(input: {
  business: { name: string; category: string; city?: string | null };
  facts: AiPromptFact[];
  signals: WebsiteSignals | null;
  researchStatus: string | null;
  score: QualificationScore;
  promptVersion: string;
}) {
  const facts = input.facts.slice(0, 60).map((f) => ({
    id: f.id,
    field: f.field,
    value: CONTACT_FIELDS.has(f.field)
      ? `[${f.field} present, value withheld]`
      : f.value.slice(0, 200),
    source: f.sourceType,
    status: f.verificationStatus,
  }));
  const signals = input.signals
    ? Object.fromEntries(
        Object.entries(input.signals).filter(([k]) =>
          [
            "noWebsite",
            "socialProfileOnly",
            "https",
            "hasViewport",
            "hasTitle",
            "hasMetaDescription",
            "responseTimeMs",
            "copyrightYear",
            "tech",
            "broken",
            "httpStatus",
          ].includes(k),
        ),
      )
    : null;
  const system = [
    "You help a small web-design agency in India decide how to approach local businesses.",
    "Use ONLY the facts and signals given. Do not invent facts, prices, reviews or names.",
    "Do not change or comment on the numeric score; it is computed by fixed rules.",
    'Answer with one JSON object: {"summary": string (<= 600 chars), "pitchAngle": string (<= 400 chars), "riskFlags": [{"code": one of ' +
      AI_RISK_CODES.join("|") +
      ', "text": string, "factIds": [fact ids from the input]}]}.',
  ].join("\n");
  const prompt = JSON.stringify(
    {
      promptVersion: input.promptVersion,
      business: input.business,
      rulesScore: {
        score: input.score.score,
        tier: input.score.tier,
        reasons: input.score.reasons.map((r) => r.text),
      },
      researchStatus: input.researchStatus,
      websiteSignals: signals,
      facts,
    },
    null,
    1,
  );
  return { system, prompt };
}

/** Keeps only fact ids that were in the input (a model must not cite facts it was not given). */
export function sanitizeAiOutput(out: QualificationAiOutput, knownFactIds: ReadonlySet<string>) {
  let dropped = 0;
  const riskFlags = out.riskFlags.map((r) => {
    const keep = r.factIds.filter((id) => knownFactIds.has(id));
    dropped += r.factIds.length - keep.length;
    return { ...r, factIds: keep };
  });
  return { output: { ...out, riskFlags }, droppedFactIds: dropped };
}

// ---------------- filter scope ----------------

export interface QualificationFilter {
  category?: string;
  city?: string;
  status?: string;
  hasWebsite?: boolean;
  tier?: QualificationTier;
  /** Only businesses never qualified, or last qualified before this many days ago. */
  staleAfterDays?: number;
  limit?: number;
}

export function parseQualificationFilter(input: unknown): QualificationFilter {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Qualification filter must be an object");
  const o = input as Record<string, unknown>;
  const allowed = ["category", "city", "status", "hasWebsite", "tier", "staleAfterDays", "limit"];
  const unknown = Object.keys(o).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new Error(`Unknown qualification filter keys: ${unknown.join(", ")}`);
  const out: QualificationFilter = {};
  for (const k of ["category", "city", "status"] as const) {
    const v = o[k];
    if (v === undefined) continue;
    if (typeof v !== "string" || !v.trim() || v.length > 100)
      throw new Error(`Qualification filter ${k} must be a non-empty string`);
    out[k] = v.trim();
  }
  if (o.hasWebsite !== undefined) {
    if (typeof o.hasWebsite !== "boolean") throw new Error("hasWebsite must be a boolean");
    out.hasWebsite = o.hasWebsite;
  }
  if (o.tier !== undefined) {
    if (!(QUALIFICATION_TIERS as readonly unknown[]).includes(o.tier))
      throw new Error(`tier must be one of ${QUALIFICATION_TIERS.join(", ")}`);
    out.tier = o.tier as QualificationTier;
  }
  for (const k of ["staleAfterDays", "limit"] as const) {
    const v = o[k];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1)
      throw new Error(`Qualification filter ${k} must be a positive integer`);
    out[k] = v;
  }
  if (out.limit !== undefined)
    out.limit = Math.min(out.limit, QUALIFICATION_MAX_BUSINESSES_PER_RUN);
  return out;
}
