"use server";
// Phase 6 CRM server actions (no-JS forms for the /crm, /crm/leads/[id], /leads and business pages).
// Each one checks RBAC server-side, validates with zod in src/server/crm.ts and redirects back
// with ?ok= / ?error= (runAction). Audit entries are written by the service.
import { revalidatePath } from "next/cache";
import {
  addActivity,
  assignLead,
  cancelTask,
  changeStage,
  clearContactStatus,
  createContact,
  createLeads,
  createTask,
  deleteContact,
  editNote,
  parseId,
  setContactStatus,
  setTags,
  updateContact,
  updateLead,
  updateTask,
} from "../crm";
import { assertPermission } from "../session";
import { runAction } from "./util";

const LIST = "/crm";
const DETAIL = /^\/crm\/leads\/[0-9a-f-]{36}$/i;
/** Pages a CRM form may return to (never an arbitrary URL). */
const RETURN_TO = [DETAIL, /^\/leads$/, /^\/businesses\/[0-9a-f-]{36}$/i];

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const opt = (fd: FormData, k: string) => s(fd, k) || undefined;
const optNull = (fd: FormData, k: string) => (fd.has(k) ? s(fd, k) || null : undefined);
const num = (fd: FormData, k: string) => (s(fd, k) ? Number(s(fd, k)) : undefined);
/** datetime-local inputs carry no zone: the form sends tzOffset (minutes, from the browser). */
function isoFromLocal(fd: FormData, k: string): string | null | undefined {
  if (!fd.has(k)) return undefined;
  const v = s(fd, k);
  if (!v) return null;
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(v)) return v;
  const off = Number(s(fd, "tzOffset") || "-330"); // default Asia/Kolkata (UTC+05:30)
  const sign = off <= 0 ? "+" : "-";
  const a = Math.abs(off);
  const hh = String(Math.floor(a / 60)).padStart(2, "0");
  const mm = String(a % 60).padStart(2, "0");
  return `${v.length === 16 ? `${v}:00` : v}${sign}${hh}:${mm}`;
}

function back(fd: FormData) {
  const p = s(fd, "returnTo");
  return RETURN_TO.some((r) => r.test(p)) ? p : LIST;
}
const leadPath = (leadId: string) => `/crm/leads/${leadId}`;

export async function promoteLeadsAction(fd: FormData) {
  const path = back(fd);
  await runAction(path, "Leads promoted", async () => {
    const session = await assertPermission("crm:write");
    const scope = s(fd, "scope") || "all";
    const tiers = fd.getAll("tiers").map(String).filter(Boolean);
    const common = {
      tiers: tiers.length ? tiers : undefined,
      assign: s(fd, "assign") === "round_robin" ? "round_robin" : "none",
    };
    const body =
      scope === "qualification_run"
        ? { scope, runId: s(fd, "runId"), ...common, limit: num(fd, "limit") }
        : scope === "businesses"
          ? { scope, businessIds: fd.getAll("businessIds").map(String), ...common }
          : { scope: "all", ...common, limit: num(fd, "limit") ?? 200 };
    const out = await createLeads(session.user, body);
    revalidatePath(LIST);
    revalidatePath("/leads");
    if (!("promoted" in out) || !out.promoted) return;
    const r = out.promoted;
    const sk = r.skipped;
    return (
      `Promoted ${r.created.length} new lead${r.created.length === 1 ? "" : "s"} ` +
      `(tiers ${r.tiers.join(", ")}; considered ${r.considered}; skipped: ${sk.has_lead} already in CRM, ` +
      `${sk.tier_not_selected} other tier, ${sk.disqualified} disqualified, ${sk.do_not_contact} do-not-contact)`
    );
  });
}

export async function createManualLeadAction(fd: FormData) {
  await runAction(back(fd), "Added to CRM", async () => {
    const session = await assertPermission("crm:write");
    await createLeads(session.user, {
      scope: "manual",
      businessId: s(fd, "businessId"),
      assigneeId: optNull(fd, "assigneeId"),
      priority: opt(fd, "priority"),
      note: opt(fd, "note"),
    });
    revalidatePath(LIST);
    revalidatePath("/leads");
  });
}

export async function updateLeadAction(fd: FormData) {
  const leadId = parseId(s(fd, "leadId"));
  await runAction(leadPath(leadId), "Lead saved", async () => {
    const session = await assertPermission("crm:write");
    const value = s(fd, "valueEstimateRupees");
    await updateLead(session.user, leadId, {
      version: num(fd, "version"),
      priority: opt(fd, "priority"),
      valueEstimatePaise: fd.has("valueEstimateRupees")
        ? value
          ? Math.round(Number(value) * 100)
          : null
        : undefined,
      nextFollowUpAt: isoFromLocal(fd, "nextFollowUpAt"),
      lawfulBasisNote: optNull(fd, "lawfulBasisNote"),
    });
    revalidatePath(leadPath(leadId));
  });
}

export async function changeLeadStageAction(fd: FormData) {
  const leadId = parseId(s(fd, "leadId"));
  await runAction(leadPath(leadId), "Stage changed", async () => {
    const session = await assertPermission("crm:write");
    await changeStage(session.user, leadId, {
      version: num(fd, "version"),
      to: s(fd, "to"),
      note: opt(fd, "note"),
      lostReason: opt(fd, "lostReason"),
    });
    revalidatePath(leadPath(leadId));
    revalidatePath(LIST);
  });
}

export async function assignLeadAction(fd: FormData) {
  const leadId = parseId(s(fd, "leadId"));
  await runAction(leadPath(leadId), "Assignment saved", async () => {
    const session = await assertPermission("crm:write");
    await assignLead(session.user, leadId, {
      version: num(fd, "version"),
      assigneeId: s(fd, "assigneeId") || null,
    });
    revalidatePath(leadPath(leadId));
  });
}

export async function addLeadActivityAction(fd: FormData) {
  const leadId = parseId(s(fd, "leadId"));
  await runAction(leadPath(leadId), "Added to the timeline", async () => {
    const session = await assertPermission("crm:write");
    await addActivity(session.user, leadId, {
      type: s(fd, "type") || "note",
      body: s(fd, "body"),
      occurredAt: isoFromLocal(fd, "occurredAt") ?? undefined,
    });
    revalidatePath(leadPath(leadId));
  });
}

export async function editLeadNoteAction(fd: FormData) {
  const leadId = parseId(s(fd, "leadId"));
  await runAction(leadPath(leadId), "Note updated", async () => {
    const session = await assertPermission("crm:write");
    await editNote(session.user, leadId, parseId(s(fd, "activityId")), { body: s(fd, "body") });
    revalidatePath(leadPath(leadId));
  });
}

export async function createLeadTaskAction(fd: FormData) {
  const leadId = parseId(s(fd, "leadId"));
  await runAction(leadPath(leadId), "Task added", async () => {
    const session = await assertPermission("crm:write");
    await createTask(session.user, leadId, {
      title: s(fd, "title"),
      dueAt: isoFromLocal(fd, "dueAt"),
      assigneeId: optNull(fd, "assigneeId"),
    });
    revalidatePath(leadPath(leadId));
  });
}

/** status=done|open|cancelled; cancelled is also what "delete" does. */
export async function updateLeadTaskAction(fd: FormData) {
  const leadId = parseId(s(fd, "leadId"));
  await runAction(leadPath(leadId), "Task updated", async () => {
    const session = await assertPermission("crm:write");
    const taskId = parseId(s(fd, "taskId"));
    if (s(fd, "status") === "cancelled") await cancelTask(session.user, leadId, taskId);
    else
      await updateTask(session.user, leadId, taskId, {
        ...(fd.has("title") ? { title: s(fd, "title") } : {}),
        ...(fd.has("dueAt") ? { dueAt: isoFromLocal(fd, "dueAt") } : {}),
        ...(fd.has("assigneeId") ? { assigneeId: s(fd, "assigneeId") || null } : {}),
        ...(fd.has("status") ? { status: s(fd, "status") } : {}),
      });
    revalidatePath(leadPath(leadId));
  });
}

export async function saveLeadContactAction(fd: FormData) {
  const leadId = parseId(s(fd, "leadId"));
  await runAction(leadPath(leadId), "Contact saved", async () => {
    const session = await assertPermission("crm:write");
    const body = {
      personName: optNull(fd, "personName"),
      role: optNull(fd, "role"),
      phone: optNull(fd, "phone"),
      email: optNull(fd, "email"),
      whatsapp: optNull(fd, "whatsapp"),
      ...(fd.has("isPrimary")
        ? { isPrimary: s(fd, "isPrimary") === "on" || s(fd, "isPrimary") === "true" }
        : {}),
    };
    const clean = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    const contactId = s(fd, "contactId");
    if (contactId) await updateContact(session.user, leadId, parseId(contactId), clean);
    else await createContact(session.user, leadId, clean);
    revalidatePath(leadPath(leadId));
  });
}

export async function deleteLeadContactAction(fd: FormData) {
  const leadId = parseId(s(fd, "leadId"));
  await runAction(leadPath(leadId), "Contact removed", async () => {
    const session = await assertPermission("crm:write");
    await deleteContact(session.user, leadId, parseId(s(fd, "contactId")));
    revalidatePath(leadPath(leadId));
  });
}

export async function setLeadTagsAction(fd: FormData) {
  const leadId = parseId(s(fd, "leadId"));
  await runAction(leadPath(leadId), "Tags saved", async () => {
    const session = await assertPermission("crm:write");
    const tags = s(fd, "tags")
      .split(/[,;]/)
      .map((t) => t.trim())
      .filter(Boolean);
    await setTags(session.user, leadId, { tags });
    revalidatePath(leadPath(leadId));
  });
}

export async function setLeadDncAction(fd: FormData) {
  const leadId = parseId(s(fd, "leadId"));
  await runAction(leadPath(leadId), "Marked do-not-contact", async () => {
    const session = await assertPermission("crm:write");
    await setContactStatus(session.user, leadId, {
      status: s(fd, "status") || "do_not_contact",
      reason: s(fd, "reason"),
      lawfulBasisNote: opt(fd, "lawfulBasisNote"),
    });
    revalidatePath(leadPath(leadId));
  });
}

export async function clearLeadDncAction(fd: FormData) {
  const leadId = parseId(s(fd, "leadId"));
  await runAction(leadPath(leadId), "Do-not-contact cleared", async () => {
    const session = await assertPermission("crm:dnc_clear");
    await clearContactStatus(session.user, leadId, { reason: s(fd, "reason") });
    revalidatePath(leadPath(leadId));
  });
}
