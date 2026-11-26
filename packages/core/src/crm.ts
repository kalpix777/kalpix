/**
 * CRM and lead management (Phase 6). Pure rules only: stage transitions, follow-up and health,
 * note edit window, tags, promotion planning (tiers + round-robin) and CSV import validation with
 * dedupe keys. No database, no network, no outbound messaging (that is Phases 11-12).
 */
import { z } from "zod";
import { KALPIX_CATEGORIES } from "./discovery";

// ---------------- vocabularies (mirror the Prisma enums) ----------------

export const LEAD_STAGES = [
  "new",
  "contacted",
  "interested",
  "demo_requested",
  "proposal_sent",
  "negotiating",
  "won",
  "lost",
  "nurture",
] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

export const LEAD_PRIORITIES = ["low", "normal", "high"] as const;
export type LeadPriority = (typeof LEAD_PRIORITIES)[number];

export const LEAD_SOURCES = ["qualification", "manual", "import"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const LEAD_ACTIVITY_TYPES = [
  "note",
  "call_logged",
  "meeting_logged",
  "stage_change",
  "assignment",
  "task_done",
  "system",
] as const;
export type LeadActivityType = (typeof LEAD_ACTIVITY_TYPES)[number];
/** Types a person may add by hand; the rest are written by the system. */
export const MANUAL_ACTIVITY_TYPES = ["note", "call_logged", "meeting_logged"] as const;
export type ManualActivityType = (typeof MANUAL_ACTIVITY_TYPES)[number];

export const LEAD_TASK_STATUSES = ["open", "done", "cancelled"] as const;
export type LeadTaskStatus = (typeof LEAD_TASK_STATUSES)[number];

export const CONTACT_STATUSES = ["ok", "do_not_contact", "opted_out"] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

/** Tiers a lead can be promoted from. "disqualified" is never promotable. */
export const PROMOTABLE_TIERS = ["hot", "warm", "cold"] as const;
export type PromotableTier = (typeof PROMOTABLE_TIERS)[number];

export const CRM_PAGE_SIZE = 50;
export const CRM_MAX_PROMOTE = 1000;
export const CRM_MAX_IMPORT_ROWS = 1000;
export const CRM_EXPORT_MAX_ROWS = 50_000;
export const NOTE_EDIT_WINDOW_MS = 15 * 60 * 1000;
export const DEFAULT_CRM_STALE_DAYS = 14;
export const DEFAULT_CRM_PROMOTE_TIERS: readonly PromotableTier[] = ["hot", "warm"];

// ---------------- stage transitions ----------------

export const TERMINAL_STAGES: readonly LeadStage[] = ["won", "lost"];
/** Stages that imply outreach: a do-not-contact / opted-out business can never enter them. */
export const OUTREACH_STAGES: readonly LeadStage[] = [
  "contacted",
  "demo_requested",
  "proposal_sent",
  "negotiating",
];
/** Where an admin may reopen a won or lost lead to. */
export const REOPEN_TARGETS: readonly LeadStage[] = ["nurture", "contacted"];

/** Forward and sideways moves for open leads. won/lost leave only by reopening (admin+). */
export const STAGE_TRANSITIONS: Readonly<Record<LeadStage, readonly LeadStage[]>> = {
  new: ["contacted", "interested", "nurture", "lost"],
  contacted: ["interested", "demo_requested", "nurture", "lost"],
  interested: ["contacted", "demo_requested", "proposal_sent", "won", "nurture", "lost"],
  demo_requested: ["interested", "proposal_sent", "won", "nurture", "lost"],
  proposal_sent: ["interested", "negotiating", "won", "nurture", "lost"],
  negotiating: ["proposal_sent", "won", "nurture", "lost"],
  nurture: ["contacted", "interested", "lost"],
  won: [],
  lost: [],
};

export const isTerminalStage = (s: LeadStage) => TERMINAL_STAGES.includes(s);

export type StageTransitionError =
  | "unknown_stage"
  | "same_stage"
  | "not_allowed"
  | "reopen_requires_admin"
  | "lost_reason_required"
  | "do_not_contact";

export type StageTransitionResult =
  { ok: true; reopen: boolean } | { ok: false; code: StageTransitionError; message: string };

export interface StageTransitionInput {
  from: LeadStage;
  to: string;
  /** Consent state of the lead's business. */
  contactStatus: ContactStatus;
  /** Required (non-blank) when moving to "lost". */
  lostReason?: string | null;
  /** The actor holds crm:reopen (admin, owner). */
  canReopen: boolean;
}

const LOST_REASON_MAX = 500;

/**
 * Decides whether a lead may move from one stage to another. Rules: the matrix above for open
 * leads; won/lost are terminal but reopenable to nurture or contacted by admin+; "lost" needs a
 * reason; a do-not-contact or opted-out business can never move into an outreach stage.
 */
export function checkStageTransition(i: StageTransitionInput): StageTransitionResult {
  if (!(LEAD_STAGES as readonly string[]).includes(i.to))
    return { ok: false, code: "unknown_stage", message: `Unknown stage "${i.to}"` };
  const to = i.to as LeadStage;
  if (to === i.from)
    return { ok: false, code: "same_stage", message: `The lead is already ${label(to)}` };
  const reopen = isTerminalStage(i.from);
  if (reopen) {
    if (!REOPEN_TARGETS.includes(to))
      return {
        ok: false,
        code: "not_allowed",
        message: `A ${label(i.from)} lead can only be reopened to nurture or contacted`,
      };
    if (!i.canReopen)
      return {
        ok: false,
        code: "reopen_requires_admin",
        message: "Only admins and owners can reopen a won or lost lead",
      };
  } else if (!STAGE_TRANSITIONS[i.from].includes(to)) {
    return {
      ok: false,
      code: "not_allowed",
      message: `A lead cannot move from ${label(i.from)} to ${label(to)}`,
    };
  }
  if (i.contactStatus !== "ok" && OUTREACH_STAGES.includes(to))
    return {
      ok: false,
      code: "do_not_contact",
      message: `This business is marked ${label(i.contactStatus)}: it cannot move to ${label(to)}`,
    };
  if (to === "lost") {
    const reason = (i.lostReason ?? "").trim();
    if (reason.length < 3 || reason.length > LOST_REASON_MAX)
      return {
        ok: false,
        code: "lost_reason_required",
        message: `A lost lead needs a reason (3-${LOST_REASON_MAX} characters)`,
      };
  }
  return { ok: true, reopen };
}

/** Stages a lead may move to next, for the UI (the server re-checks with checkStageTransition). */
export function allowedNextStages(
  from: LeadStage,
  contactStatus: ContactStatus,
  canReopen: boolean,
): LeadStage[] {
  return LEAD_STAGES.filter(
    (to) =>
      checkStageTransition({ from, to, contactStatus, canReopen, lostReason: "x".repeat(3) }).ok,
  );
}

const label = (s: string) => s.replace(/_/g, " ");

// ---------------- follow-up, health, note editing ----------------

/** A follow-up is overdue when its time has passed and the lead is still open. */
export function isFollowUpOverdue(
  lead: { stage: LeadStage; nextFollowUpAt: Date | null },
  now: Date,
): boolean {
  return (
    !isTerminalStage(lead.stage) &&
    lead.nextFollowUpAt !== null &&
    lead.nextFollowUpAt.getTime() < now.getTime()
  );
}

/** An open task is overdue when it has a due time in the past. */
export function isTaskOverdue(
  task: { status: LeadTaskStatus; dueAt: Date | null },
  now: Date,
): boolean {
  return task.status === "open" && task.dueAt !== null && task.dueAt.getTime() < now.getTime();
}

export type LeadHealth = "active" | "stale" | "closed";

/** closed = won/lost; stale = open with no activity for `staleDays` days or more; else active. */
export function leadHealth(
  lead: { stage: LeadStage; lastActivityAt: Date },
  now: Date,
  staleDays: number = DEFAULT_CRM_STALE_DAYS,
): { health: LeadHealth; daysSinceActivity: number } {
  const daysSinceActivity = Math.max(
    0,
    Math.floor((now.getTime() - lead.lastActivityAt.getTime()) / 86_400_000),
  );
  if (isTerminalStage(lead.stage)) return { health: "closed", daysSinceActivity };
  return { health: daysSinceActivity >= staleDays ? "stale" : "active", daysSinceActivity };
}

/** A lead whose last activity is before this instant is stale (for list filters). */
export const staleCutoff = (now: Date, staleDays: number) =>
  new Date(now.getTime() - staleDays * 86_400_000);

/** Only the author may edit a note, and only within 15 minutes (the database enforces the window). */
export function canEditActivity(
  activity: { type: LeadActivityType; authorId: string | null; createdAt: Date },
  actorId: string,
  now: Date,
): { ok: true } | { ok: false; message: string } {
  if (activity.type !== "note") return { ok: false, message: "Only notes can be edited" };
  if (!activity.authorId || activity.authorId !== actorId)
    return { ok: false, message: "Only the author can edit a note" };
  if (now.getTime() - activity.createdAt.getTime() > NOTE_EDIT_WINDOW_MS)
    return { ok: false, message: "Notes can be edited only within 15 minutes" };
  return { ok: true };
}

// ---------------- tags ----------------

export const TAG_NAME_MAX = 40;
const TAG_RE = /^[\p{L}\p{N}][\p{L}\p{N} _\-/&.]*$/u;

/** Display name: trimmed, inner whitespace collapsed. */
export const cleanTagName = (name: string) => name.trim().replace(/\s+/g, " ");
/** Case-insensitive identity (matches the lead_tag.key CHECK: lower(trim(name))). */
export const tagKey = (name: string) => cleanTagName(name).toLowerCase();

export const tagNameSchema = z
  .string()
  .transform(cleanTagName)
  .pipe(
    z
      .string()
      .min(1, "Tag cannot be empty")
      .max(TAG_NAME_MAX, `Tags are at most ${TAG_NAME_MAX} characters`)
      .regex(TAG_RE, "Tags use letters, digits, space, - _ / & ."),
  );

/** Validates and de-duplicates (case-insensitively, first spelling wins) a list of tag names. */
export function normalizeTagList(names: readonly string[]): string[] {
  const out = new Map<string, string>();
  for (const n of names) {
    const v = tagNameSchema.parse(n);
    if (!out.has(v.toLowerCase())) out.set(v.toLowerCase(), v);
  }
  return [...out.values()];
}

// ---------------- configuration ----------------

export interface CrmSettings {
  staleDays: number;
  promoteTiers: PromotableTier[];
}

/** Parses CRM_PROMOTE_TIERS ("hot,warm"); throws on unknown or disqualified tiers. */
export function parsePromoteTiers(value: string | undefined | null): PromotableTier[] {
  const raw = (value ?? "").trim();
  if (!raw) return [...DEFAULT_CRM_PROMOTE_TIERS];
  const tiers = [...new Set(raw.split(",").map((t) => t.trim().toLowerCase()))].filter(Boolean);
  for (const t of tiers)
    if (!(PROMOTABLE_TIERS as readonly string[]).includes(t))
      throw new Error(
        `CRM_PROMOTE_TIERS: "${t}" is not promotable (use hot, warm and/or cold; disqualified never)`,
      );
  if (!tiers.length) return [...DEFAULT_CRM_PROMOTE_TIERS];
  return tiers as PromotableTier[];
}

/** CRM_STALE_DAYS (1-365, default 14) and CRM_PROMOTE_TIERS (default hot,warm). */
export function crmSettingsFromEnv(env: Record<string, string | undefined>): CrmSettings {
  const rawDays = (env.CRM_STALE_DAYS ?? "").trim();
  let staleDays = DEFAULT_CRM_STALE_DAYS;
  if (rawDays) {
    const n = Number(rawDays);
    if (!Number.isInteger(n) || n < 1 || n > 365)
      throw new Error("CRM_STALE_DAYS must be a whole number of days between 1 and 365");
    staleDays = n;
  }
  return { staleDays, promoteTiers: parsePromoteTiers(env.CRM_PROMOTE_TIERS) };
}

// ---------------- promotion planning ----------------

/**
 * Round-robin assignment: continues after `lastUserId` in the (sorted) list of active operators.
 * Returns one assignee per lead, or nulls when nobody is available.
 */
export function roundRobinAssignees(
  userIds: readonly string[],
  lastUserId: string | null | undefined,
  count: number,
): (string | null)[] {
  const ids = [...new Set(userIds)].sort();
  if (!ids.length) return Array.from({ length: count }, () => null);
  const start = lastUserId ? ids.findIndex((id) => id > lastUserId) : 0;
  const offset = start === -1 ? 0 : start;
  return Array.from({ length: count }, (_, i) => ids[(offset + i) % ids.length] ?? null);
}

export interface PromotionCandidate {
  businessId: string;
  tier: string | null;
  contactStatus: ContactStatus;
  hasLead: boolean;
}

export type PromotionSkip = "has_lead" | "tier_not_selected" | "disqualified" | "do_not_contact";

/** Which candidates become leads. Never disqualified, never a business that already has a lead. */
export function planPromotion(
  candidates: readonly PromotionCandidate[],
  tiers: readonly PromotableTier[],
): { promote: PromotionCandidate[]; skipped: { businessId: string; reason: PromotionSkip }[] } {
  const promote: PromotionCandidate[] = [];
  const skipped: { businessId: string; reason: PromotionSkip }[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c.businessId)) continue;
    seen.add(c.businessId);
    if (c.hasLead) skipped.push({ businessId: c.businessId, reason: "has_lead" });
    else if (c.tier === "disqualified")
      skipped.push({ businessId: c.businessId, reason: "disqualified" });
    else if (!c.tier || !(tiers as readonly string[]).includes(c.tier))
      skipped.push({ businessId: c.businessId, reason: "tier_not_selected" });
    else if (c.contactStatus !== "ok")
      skipped.push({ businessId: c.businessId, reason: "do_not_contact" });
    else promote.push(c);
  }
  return { promote, skipped };
}

/** Facts a primary contact can be built from at promotion. */
export interface ContactFact {
  id: string;
  field: string;
  value: string;
  verificationStatus: string;
  confidence: number;
}

const STATUS_RANK: Record<string, number> = { verified: 0, unverified: 1, conflicting: 2 };

/**
 * Picks the best phone, email and WhatsApp for a lead's primary contact: verified first, then
 * unverified, then conflicting (never invalid), higher confidence first. sourceFactId is the fact
 * the phone (else email, else WhatsApp) came from.
 */
export function primaryContactFromFacts(facts: readonly ContactFact[]): {
  phone: string | null;
  email: string | null;
  whatsapp: string | null;
  sourceFactId: string | null;
} | null {
  const best = (field: string) =>
    facts
      .filter((f) => f.field === field && f.verificationStatus in STATUS_RANK)
      .sort(
        (a, b) =>
          (STATUS_RANK[a.verificationStatus] ?? 9) - (STATUS_RANK[b.verificationStatus] ?? 9) ||
          b.confidence - a.confidence ||
          a.id.localeCompare(b.id),
      )[0];
  const phone = best("phone");
  const email = best("email");
  const whatsapp = best("whatsapp");
  if (!phone && !email && !whatsapp) return null;
  return {
    phone: phone?.value ?? null,
    email: email?.value ?? null,
    whatsapp: whatsapp?.value ?? null,
    sourceFactId: (phone ?? email ?? whatsapp)?.id ?? null,
  };
}

// ---------------- CSV import ----------------

/** RFC 4180 parser (quotes, doubled quotes, CRLF/LF). Returns rows of raw cells. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const s = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (quoted) throw new Error("CSV has an unterminated quoted field");
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export const LEAD_IMPORT_COLUMNS = [
  "name",
  "category",
  "phone",
  "email",
  "whatsapp",
  "website",
  "address",
  "city",
  "state",
  "postcode",
  "lat",
  "lon",
  "contact_name",
  "contact_role",
  "priority",
  "value_estimate_paise",
  "tags",
  "note",
  "lawful_basis_note",
] as const;
export type LeadImportColumn = (typeof LEAD_IMPORT_COLUMNS)[number];

/** Indian-aware phone normalisation to E.164; null when it is not a plausible number. */
export function normalizeLeadPhone(input: string | null | undefined): string | null {
  const raw = (input ?? "").replace(/^tel:/i, "").trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  let n: string | null = null;
  if (raw.startsWith("+")) n = `+${digits}`;
  else if (digits.length === 12 && digits.startsWith("91")) n = `+${digits}`;
  else if (digits.length === 10 && /^[6-9]/.test(digits)) n = `+91${digits}`;
  else if (digits.length === 11 && digits.startsWith("0")) n = `+91${digits.slice(1)}`;
  else if (digits.length === 10 && /^[2-5]/.test(digits)) n = `+91${digits}`; // landline with STD
  if (!n) return null;
  if (n.startsWith("+91")) return /^\+91[2-9]\d{9}$/.test(n) ? n : null;
  return /^\+[1-9]\d{7,14}$/.test(n) ? n : null;
}

const NAME_STOP = new Set([
  "the",
  "pvt",
  "private",
  "ltd",
  "limited",
  "llp",
  "inc",
  "co",
  "company",
  "and",
]);

/** Name key for dedupe (same idea as the discovery normaliser: case, accents, legal suffixes). */
export function businessNameKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((t) => t && !NAME_STOP.has(t))
    .join(" ");
}

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `At most ${max} characters`)
    .transform((v) => (v === "" ? undefined : v))
    .optional();

const optNumber = (min: number, max: number, what: string) =>
  z
    .string()
    .trim()
    .transform((v, ctx) => {
      if (v === "") return undefined;
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max) {
        ctx.addIssue({ code: "custom", message: `${what} must be between ${min} and ${max}` });
        return z.NEVER;
      }
      return n;
    })
    .optional();

export const leadImportRowSchema = z
  .object({
    name: z.string().trim().min(2, "Name is required").max(200),
    category: z
      .string()
      .trim()
      .toLowerCase()
      .pipe(z.enum(KALPIX_CATEGORIES, { message: "Unknown category" })),
    phone: optText(40).transform((v, ctx) => {
      if (v === undefined) return undefined;
      const n = normalizeLeadPhone(v);
      if (!n) {
        ctx.addIssue({ code: "custom", message: "Not a valid phone number" });
        return z.NEVER;
      }
      return n;
    }),
    whatsapp: optText(40).transform((v, ctx) => {
      if (v === undefined) return undefined;
      const n = normalizeLeadPhone(v);
      if (!n) {
        ctx.addIssue({ code: "custom", message: "Not a valid WhatsApp number" });
        return z.NEVER;
      }
      return n;
    }),
    email: optText(254)
      .transform((v) => v?.toLowerCase())
      .pipe(z.email("Not a valid email").optional()),
    website: optText(500).transform((v, ctx) => {
      if (v === undefined) return undefined;
      const withScheme = /^https?:\/\//i.test(v) ? v : `https://${v}`;
      try {
        const u = new URL(withScheme);
        if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) throw new Error("bad");
        return u.toString();
      } catch {
        ctx.addIssue({ code: "custom", message: "Not a valid website" });
        return z.NEVER;
      }
    }),
    address: optText(500),
    city: optText(100),
    state: optText(100),
    postcode: optText(10).pipe(
      z
        .string()
        .regex(/^[1-9][0-9]{5}$/, "PIN code must be 6 digits")
        .optional(),
    ),
    lat: optNumber(-90, 90, "lat"),
    lon: optNumber(-180, 180, "lon"),
    contact_name: optText(120),
    contact_role: optText(80),
    priority: optText(10).pipe(z.enum(LEAD_PRIORITIES).optional()),
    value_estimate_paise: optText(15).transform((v, ctx) => {
      if (v === undefined) return undefined;
      if (!/^\d{1,10}$/.test(v) || Number(v) > 2_000_000_000) {
        ctx.addIssue({
          code: "custom",
          message: "value_estimate_paise must be a whole number of paise (max 2,000,000,000)",
        });
        return z.NEVER;
      }
      return Number(v);
    }),
    tags: optText(400).transform((v, ctx) => {
      if (v === undefined) return [] as string[];
      try {
        return normalizeTagList(v.split(/[;|]/).filter((t) => t.trim()));
      } catch (err) {
        ctx.addIssue({
          code: "custom",
          message:
            err instanceof z.ZodError ? (err.issues[0]?.message ?? "Invalid tag") : "Invalid tag",
        });
        return z.NEVER;
      }
    }),
    note: optText(2000),
    lawful_basis_note: optText(500),
  })
  .superRefine((r, ctx) => {
    if ((r.lat === undefined) !== (r.lon === undefined))
      ctx.addIssue({ code: "custom", path: ["lat"], message: "Give both lat and lon, or neither" });
    if (!r.phone && !r.email && !r.whatsapp)
      ctx.addIssue({
        code: "custom",
        path: ["phone"],
        message: "Give at least one of phone, email or whatsapp",
      });
  });
export type LeadImportRow = z.infer<typeof leadImportRowSchema>;

export interface ImportRowError {
  /** 1-based line number in the file (the header is line 1). */
  line: number;
  message: string;
}

export interface ParsedImport {
  rows: { line: number; row: LeadImportRow }[];
  errors: ImportRowError[];
}

/**
 * Parses and validates a lead CSV. Header names are matched case-insensitively; unknown columns
 * are an error (typos must not silently drop data); "name" and "category" are required columns.
 * Rows that repeat an earlier row of the same file (same phone, or same name + PIN) are errors.
 */
export function parseLeadImport(text: string, maxRows = CRM_MAX_IMPORT_ROWS): ParsedImport {
  const table = parseCsv(text);
  const header = (table[0] ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  if (!header.length) return { rows: [], errors: [{ line: 1, message: "The file is empty" }] };
  const unknown = header.filter((h) => !(LEAD_IMPORT_COLUMNS as readonly string[]).includes(h));
  const missing = ["name", "category"].filter((h) => !header.includes(h));
  const dupCols = header.filter((h, i) => header.indexOf(h) !== i);
  const headerErrors: string[] = [];
  if (unknown.length) headerErrors.push(`Unknown column(s): ${unknown.join(", ")}`);
  if (missing.length) headerErrors.push(`Missing column(s): ${missing.join(", ")}`);
  if (dupCols.length) headerErrors.push(`Repeated column(s): ${[...new Set(dupCols)].join(", ")}`);
  if (headerErrors.length)
    return { rows: [], errors: [{ line: 1, message: headerErrors.join("; ") }] };
  const body = table.slice(1);
  if (body.length > maxRows)
    return {
      rows: [],
      errors: [{ line: 1, message: `At most ${maxRows} rows per import (got ${body.length})` }],
    };
  const rows: ParsedImport["rows"] = [];
  const errors: ImportRowError[] = [];
  const seen = new Map<string, number>();
  body.forEach((cells, i) => {
    const line = i + 2;
    if (cells.length > header.length) {
      errors.push({ line, message: `Has ${cells.length} cells, the header has ${header.length}` });
      return;
    }
    const obj = Object.fromEntries(header.map((h, j) => [h, cells[j] ?? ""]));
    const parsed = leadImportRowSchema.safeParse(obj);
    if (!parsed.success) {
      errors.push({
        line,
        message: parsed.error.issues
          .map((iss) => `${iss.path.join(".") || "row"}: ${iss.message}`)
          .join("; "),
      });
      return;
    }
    const keys = importDedupeKeys(parsed.data);
    const prior = keys.map((k) => seen.get(k)).find((v) => v !== undefined);
    if (prior !== undefined) {
      errors.push({ line, message: `Duplicate of line ${prior} in this file` });
      return;
    }
    for (const k of keys) seen.set(k, line);
    rows.push({ line, row: parsed.data });
  });
  return { rows, errors };
}

/** Dedupe keys: "phone:+91..." and "name:<key>|<pin>" (name+PIN only when a PIN is given). */
export function importDedupeKeys(r: {
  name: string;
  phone?: string | null;
  postcode?: string | null;
}): string[] {
  const keys: string[] = [];
  const phone = normalizeLeadPhone(r.phone ?? null);
  if (phone) keys.push(`phone:${phone}`);
  const nk = businessNameKey(r.name);
  if (nk && r.postcode) keys.push(`name:${nk}|${r.postcode}`);
  return keys;
}

export interface ExistingBusinessKey {
  id: string;
  name: string;
  phone: string | null;
  postcode: string | null;
}

/** Finds an existing business matching an import row by normalised phone or name + PIN code. */
export function findExistingBusiness<T extends ExistingBusinessKey>(
  row: { name: string; phone?: string | null; postcode?: string | null },
  existing: readonly T[],
): { business: T; by: "phone" | "name_postcode" } | null {
  const phone = normalizeLeadPhone(row.phone ?? null);
  if (phone) {
    const hit = existing.find((b) => normalizeLeadPhone(b.phone) === phone);
    if (hit) return { business: hit, by: "phone" };
  }
  if (row.postcode) {
    const nk = businessNameKey(row.name);
    const hit = existing.find(
      (b) => b.postcode === row.postcode && nk !== "" && businessNameKey(b.name) === nk,
    );
    if (hit) return { business: hit, by: "name_postcode" };
  }
  return null;
}

// ---------------- list filters ----------------

export const leadListFilterSchema = z.object({
  stage: z.enum(LEAD_STAGES).optional(),
  /** a user id, "me" or "none" (unassigned) */
  assignee: z
    .string()
    .trim()
    .regex(/^(me|none|[0-9A-Za-z_-]{1,64})$/, "Invalid assignee")
    .optional(),
  tier: z.enum(["hot", "warm", "cold", "disqualified"]).optional(),
  tag: z.string().trim().min(1).max(TAG_NAME_MAX).optional(),
  overdue: z.boolean().optional(),
  stale: z.boolean().optional(),
  contactStatus: z.enum(CONTACT_STATUSES).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  page: z.number().int().min(1).max(10_000).default(1),
});
export type LeadListFilter = z.infer<typeof leadListFilterSchema>;

/** Query-string parser: blanks are ignored; "yes"/"true"/"1" are true. Throws ZodError. */
export function parseLeadListFilter(params: Record<string, string | undefined>): LeadListFilter {
  const v = (k: string) => {
    const s = params[k]?.trim();
    return s ? s : undefined;
  };
  const bool = (k: string) => {
    const s = v(k)?.toLowerCase();
    if (s === undefined) return undefined;
    if (["yes", "true", "1"].includes(s)) return true;
    if (["no", "false", "0"].includes(s)) return false;
    return s as unknown as boolean; // let zod reject it
  };
  const page = v("page");
  return leadListFilterSchema.parse({
    stage: v("stage"),
    assignee: v("assignee"),
    tier: v("tier"),
    tag: v("tag"),
    overdue: bool("overdue"),
    stale: bool("stale"),
    contactStatus: v("contactStatus") ?? v("contact_status"),
    q: v("q"),
    page: page === undefined ? undefined : Number(page),
  });
}
