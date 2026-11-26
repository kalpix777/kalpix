// Phase 6 CRM display helpers (pure, unit-tested): labels, tones, query strings, IST inputs, INR.
import { LEAD_STAGES, type LeadListFilter, type LeadStage } from "@kalpix/core";

type Tone = "neutral" | "green" | "amber" | "red" | "brand";

export const stageLabel = (s: string) => {
  const t = s.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export const STAGE_TONE: Record<LeadStage, Tone> = {
  new: "brand",
  contacted: "neutral",
  interested: "amber",
  demo_requested: "amber",
  proposal_sent: "amber",
  negotiating: "amber",
  won: "green",
  lost: "red",
  nurture: "neutral",
};

export const PRIORITY_TONE: Record<string, Tone> = {
  high: "red",
  normal: "neutral",
  low: "neutral",
};

export const ACTIVITY_LABEL: Record<string, string> = {
  note: "Note",
  call_logged: "Call",
  meeting_logged: "Meeting",
  stage_change: "Stage",
  assignment: "Assignment",
  task_done: "Task done",
  system: "System",
};

export const CONTACT_STATUS_LABEL: Record<string, string> = {
  ok: "OK to contact",
  do_not_contact: "Do not contact",
  opted_out: "Opted out",
};

export const PIPELINE_STAGES: readonly LeadStage[] = LEAD_STAGES;

/** Query string for the /crm list from the current filter plus overrides; blanks dropped. */
export function crmQuery(
  f: Partial<Omit<LeadListFilter, "page">> & { page?: number },
  overrides: Record<string, string | undefined> = {},
): string {
  const p = new URLSearchParams();
  const put = (k: string, v: unknown) => {
    if (v === undefined || v === null || v === "") return;
    p.set(k, typeof v === "boolean" ? (v ? "yes" : "no") : String(v));
  };
  put("stage", f.stage);
  put("assignee", f.assignee);
  put("tier", f.tier);
  put("tag", f.tag);
  put("overdue", f.overdue);
  put("stale", f.stale);
  put("contactStatus", f.contactStatus);
  put("q", f.q);
  if (f.page && f.page > 1) put("page", f.page);
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined || v === "") p.delete(k);
    else p.set(k, v);
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

const IST_OFFSET_MS = 330 * 60_000;

/** A Date as the value of a datetime-local input in IST (YYYY-MM-DDTHH:mm). */
export function toIstInput(d: Date | string | null | undefined): string {
  if (!d) return "";
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return "";
  return new Date(t.getTime() + IST_OFFSET_MS).toISOString().slice(0, 16);
}

/** Paise as rupees for an input value (no grouping): 1234550 -> "12345.50", null -> "". */
export function paiseToRupeesInput(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return "";
  return paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2);
}

/** Paise as an INR display string: 1234550 -> "₹12,345.50", null -> "—". */
export function formatInr(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: paise % 100 === 0 ? 0 : 2,
    minimumFractionDigits: paise % 100 === 0 ? 0 : 2,
  }).format(paise / 100);
}

/** True when an action error is the optimistic-concurrency (409) message. */
export const isConflictMessage = (msg: string | undefined) =>
  !!msg && /changed by someone else/i.test(msg);
