import Link from "next/link";
import { notFound } from "next/navigation";
import { categoryLabel } from "@kalpix/providers";
import { can } from "@/lib/rbac";
import { formatDateTime } from "@/lib/utils";
import {
  ACTIVITY_LABEL,
  CONTACT_STATUS_LABEL,
  formatInr,
  isConflictMessage,
  paiseToRupeesInput,
  PRIORITY_TONE,
  STAGE_TONE,
  stageLabel,
  toIstInput,
} from "@/lib/crm-display";
import { TIER_TONE, tierLabel } from "@/lib/qualification-display";
import { PageHeader } from "@/components/page-header";
import { Flash } from "@/components/flash";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { requirePermission } from "@/server/session";
import { CrmError, getLead, listAssignees, parseId } from "@/server/crm";
import {
  addLeadActivityAction,
  assignLeadAction,
  changeLeadStageAction,
  clearLeadDncAction,
  createLeadTaskAction,
  deleteLeadContactAction,
  editLeadNoteAction,
  saveLeadContactAction,
  setLeadDncAction,
  setLeadTagsAction,
  updateLeadAction,
  updateLeadTaskAction,
} from "@/server/actions/crm";

export const metadata = { title: "Lead" };
export const dynamic = "force-dynamic";

const textarea =
  "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-100";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-3 py-1.5 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd className="col-span-2 break-words text-slate-900">{children ?? "—"}</dd>
    </div>
  );
}

export default async function LeadDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const session = await requirePermission("crm:read");
  const actor = session.user;
  const { id: raw } = await params;
  const { ok, error } = await searchParams;
  let leadId: string;
  let lead: Awaited<ReturnType<typeof getLead>>;
  try {
    leadId = parseId(raw);
    lead = await getLead(actor, leadId);
  } catch (err) {
    if (err instanceof CrmError && err.status === 404) notFound();
    throw err;
  }
  const assignees = await listAssignees(actor);
  const canWrite = can(actor.role, "crm:write");
  const canClearDnc = can(actor.role, "crm:dnc_clear");
  const canReopen = can(actor.role, "crm:reopen");
  const b = lead.business;
  const dnc = b.contactStatus !== "ok";
  const terminal = lead.stage === "won" || lead.stage === "lost";
  const path = `/crm/leads/${lead.id}`;
  const conflict = isConflictMessage(error);
  const hidden = (
    <>
      <input type="hidden" name="leadId" value={lead.id} />
      <input type="hidden" name="returnTo" value={path} />
    </>
  );
  const versioned = (
    <>
      {hidden}
      <input type="hidden" name="version" value={lead.version} />
    </>
  );
  const openTasks = lead.tasks.filter((t) => t.status === "open");
  const closedTasks = lead.tasks.filter((t) => t.status !== "open");
  const isMock = b.name.startsWith("MOCK");

  return (
    <>
      <div className="mb-3 flex flex-wrap gap-4 text-sm font-semibold">
        <Link href="/crm" className="text-brand-700">
          ← CRM
        </Link>
        <Link href={`/businesses/${b.id}`} className="text-brand-700">
          Business details →
        </Link>
      </div>
      <PageHeader
        title={b.name}
        description={`${categoryLabel(b.category)}${b.city ? ` · ${b.city}` : ""} · lead from ${lead.source} · created ${formatDateTime(lead.createdAt)} by ${lead.createdByLabel}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {isMock && <Badge tone="amber">MOCK</Badge>}
            <Badge tone={STAGE_TONE[lead.stage]}>{stageLabel(lead.stage)}</Badge>
            {b.latestTier && (
              <Badge tone={TIER_TONE[b.latestTier] ?? "neutral"}>
                {tierLabel(b.latestTier)} · {b.latestScore ?? "—"}
              </Badge>
            )}
            <Badge tone={PRIORITY_TONE[lead.priority] ?? "neutral"}>{lead.priority} priority</Badge>
            {lead.health === "stale" && (
              <Badge tone="amber">Stale · {lead.daysSinceActivity} days quiet</Badge>
            )}
            {lead.followUpOverdue && <Badge tone="red">Follow-up overdue</Badge>}
          </div>
        }
      />
      {conflict ? (
        <div
          role="alert"
          data-testid="conflict"
          className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800"
        >
          <span>
            <strong>Not saved: this lead was changed by someone else</strong> since you opened it.
            Reload to see the latest version, then make your change again.
          </span>
          <Link href={path} className="font-semibold underline">
            Reload
          </Link>
        </div>
      ) : (
        <Flash ok={ok} error={error} />
      )}

      {dnc && (
        <div
          role="note"
          data-testid="dnc-banner"
          className="mb-6 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900"
        >
          <p className="font-semibold">
            {CONTACT_STATUS_LABEL[b.contactStatus]}: do not call, message or email this business.
          </p>
          <p className="mt-0.5">
            {b.contactStatusReason ? `Reason: ${b.contactStatusReason}. ` : ""}
            {b.contactStatusByLabel ? `Set by ${b.contactStatusByLabel}` : ""}
            {b.contactStatusAt ? ` on ${formatDateTime(b.contactStatusAt)}` : ""}. Outreach stages
            are blocked and CSV exports leave out its phone and email.
          </p>
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="flex flex-col gap-6 xl:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Stage</CardTitle>
              <CardDescription>
                In {stageLabel(lead.stage)} since {formatDateTime(lead.stageChangedAt)}
                {lead.lostReason ? ` · Lost: ${lead.lostReason}` : ""}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <ol className="flex flex-wrap gap-1.5 text-xs" aria-label="Stage history">
                {lead.stageHistory.map((h) => (
                  <li
                    key={h.id}
                    className="rounded-md bg-slate-50 px-2 py-1 text-slate-600"
                    title={h.note ?? undefined}
                  >
                    <span className="font-semibold text-slate-800">{stageLabel(h.toStage)}</span> ·{" "}
                    {formatDateTime(h.at)} · {h.byLabel}
                  </li>
                ))}
              </ol>
              {canWrite && lead.allowedNextStages.length > 0 ? (
                <form
                  action={changeLeadStageAction}
                  className="grid gap-3 sm:grid-cols-[12rem_1fr_1fr_auto] sm:items-end"
                  aria-label="Change stage"
                >
                  {versioned}
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="to">Move to</Label>
                    <Select id="to" name="to" required defaultValue="">
                      <option value="" disabled>
                        Choose…
                      </option>
                      {lead.allowedNextStages.map((s) => (
                        <option key={s} value={s}>
                          {terminal ? `Reopen as ${stageLabel(s)}` : stageLabel(s)}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="stage-note">Note (optional)</Label>
                    <Input id="stage-note" name="note" maxLength={1000} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="lostReason">Lost reason</Label>
                    <Input
                      id="lostReason"
                      name="lostReason"
                      maxLength={500}
                      placeholder="Required for Lost"
                    />
                  </div>
                  <Button type="submit">Change stage</Button>
                </form>
              ) : canWrite && terminal && !canReopen ? (
                <p className="text-sm text-slate-500">
                  This lead is {stageLabel(lead.stage).toLowerCase()}. Only admins and owners can
                  reopen it.
                </p>
              ) : !canWrite ? (
                <p className="text-sm text-slate-500">Read only: your role can view leads.</p>
              ) : null}
              {canWrite && dnc && !terminal && (
                <p className="text-xs text-slate-500">
                  Contacted, demo requested, proposal sent and negotiating are unavailable while the
                  business is marked do-not-contact.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Timeline</CardTitle>
              <CardDescription>
                Notes, logged calls and meetings, stage changes and system events, newest first. You
                can edit your own notes for 15 minutes.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {canWrite && (
                <form
                  action={addLeadActivityAction}
                  className="flex flex-col gap-2"
                  aria-label="Add to timeline"
                >
                  {hidden}
                  <input type="hidden" name="tzOffset" value="-330" />
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="flex w-40 flex-col gap-1.5">
                      <Label htmlFor="act-type">Type</Label>
                      <Select id="act-type" name="type" defaultValue="note">
                        <option value="note">Note</option>
                        <option value="call_logged">Log a call</option>
                        <option value="meeting_logged">Log a meeting</option>
                      </Select>
                    </div>
                    <div className="flex w-56 flex-col gap-1.5">
                      <Label htmlFor="occurredAt">When (IST, calls/meetings)</Label>
                      <Input id="occurredAt" name="occurredAt" type="datetime-local" />
                    </div>
                  </div>
                  <Label htmlFor="act-body" className="sr-only">
                    Text
                  </Label>
                  <textarea
                    id="act-body"
                    name="body"
                    required
                    maxLength={5000}
                    rows={2}
                    className={textarea}
                    placeholder="What happened, what was agreed"
                  />
                  <div>
                    <Button type="submit" variant="secondary">
                      Add to timeline
                    </Button>
                  </div>
                </form>
              )}
              <ol className="flex flex-col divide-y divide-slate-100">
                {lead.activities.map((a) => {
                  const occurred =
                    a.metadata && typeof a.metadata === "object" && "occurredAt" in a.metadata
                      ? String((a.metadata as { occurredAt?: string }).occurredAt ?? "")
                      : "";
                  return (
                    <li key={a.id} className="py-2.5 text-sm" data-activity={a.type}>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        <Badge
                          tone={
                            a.type === "note"
                              ? "brand"
                              : a.type === "stage_change"
                                ? "amber"
                                : "neutral"
                          }
                        >
                          {ACTIVITY_LABEL[a.type] ?? a.type}
                        </Badge>
                        <span>{formatDateTime(a.createdAt)}</span>
                        <span>· {a.authorLabel}</span>
                        {occurred && <span>· happened {formatDateTime(new Date(occurred))}</span>}
                        {a.editedAt && <span>· edited</span>}
                      </div>
                      <p className="mt-1 whitespace-pre-wrap break-words text-slate-800">
                        {a.body}
                      </p>
                      {a.editableUntil && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-xs font-semibold text-brand-700">
                            Edit (until {formatDateTime(a.editableUntil)})
                          </summary>
                          <form action={editLeadNoteAction} className="mt-2 flex flex-col gap-2">
                            {hidden}
                            <input type="hidden" name="activityId" value={a.id} />
                            <textarea
                              name="body"
                              required
                              maxLength={5000}
                              rows={2}
                              defaultValue={a.body}
                              className={textarea}
                              aria-label="Note text"
                            />
                            <div>
                              <Button type="submit" variant="secondary" className="h-8">
                                Save note
                              </Button>
                            </div>
                          </form>
                        </details>
                      )}
                    </li>
                  );
                })}
              </ol>
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <dl className="divide-y divide-slate-100">
                <Row label="Assignee">
                  {lead.assignee ? lead.assignee.name || lead.assignee.email : "Unassigned"}
                </Row>
                <Row label="Value estimate">{formatInr(lead.valueEstimatePaise)}</Row>
                <Row label="Next follow-up">
                  {lead.nextFollowUpAt ? `${formatDateTime(lead.nextFollowUpAt)} IST` : null}
                </Row>
                <Row label="Last activity">{formatDateTime(lead.lastActivityAt)}</Row>
                <Row label="Phone">{dnc ? "Hidden (do not contact)" : b.phone}</Row>
                <Row label="Email">{dnc ? "Hidden (do not contact)" : b.email}</Row>
              </dl>
              {canWrite && (
                <>
                  <form
                    action={assignLeadAction}
                    className="flex items-end gap-2"
                    aria-label="Assign"
                  >
                    {versioned}
                    <div className="flex flex-1 flex-col gap-1.5">
                      <Label htmlFor="assigneeId">Assignee</Label>
                      <Select
                        id="assigneeId"
                        name="assigneeId"
                        defaultValue={lead.assignee?.id ?? ""}
                      >
                        <option value="">Unassigned</option>
                        {assignees.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name || u.email} ({u.role})
                          </option>
                        ))}
                      </Select>
                    </div>
                    <Button type="submit" variant="secondary">
                      Assign
                    </Button>
                  </form>
                  <form
                    action={updateLeadAction}
                    className="flex flex-col gap-3"
                    aria-label="Lead details"
                  >
                    {versioned}
                    <input type="hidden" name="tzOffset" value="-330" />
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="priority">Priority</Label>
                        <Select id="priority" name="priority" defaultValue={lead.priority}>
                          <option value="low">Low</option>
                          <option value="normal">Normal</option>
                          <option value="high">High</option>
                        </Select>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="valueEstimateRupees">Value (₹)</Label>
                        <Input
                          id="valueEstimateRupees"
                          name="valueEstimateRupees"
                          type="number"
                          min={0}
                          max={20000000}
                          step="0.01"
                          inputMode="decimal"
                          defaultValue={paiseToRupeesInput(lead.valueEstimatePaise)}
                          placeholder="Estimate"
                        />
                      </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="nextFollowUpAt">Next follow-up (IST)</Label>
                      <Input
                        id="nextFollowUpAt"
                        name="nextFollowUpAt"
                        type="datetime-local"
                        defaultValue={toIstInput(lead.nextFollowUpAt)}
                      />
                    </div>
                    <div>
                      <Button type="submit" variant="secondary">
                        Save details
                      </Button>
                    </div>
                  </form>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Tasks</CardTitle>
              <CardDescription>
                {openTasks.length} open
                {openTasks.some((t) => t.overdue)
                  ? `, ${openTasks.filter((t) => t.overdue).length} overdue`
                  : ""}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <ul className="flex flex-col gap-2">
                {openTasks.map((t) => (
                  <li
                    key={t.id}
                    className="rounded-md border border-slate-200 px-3 py-2 text-sm"
                    data-task="open"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-medium text-slate-900">{t.title}</span>
                      {t.overdue && <Badge tone="red">Overdue</Badge>}
                    </div>
                    <p className="text-xs text-slate-500">
                      {t.dueAt ? `Due ${formatDateTime(t.dueAt)} IST` : "No due date"} ·{" "}
                      {t.assignee ? t.assignee.name || t.assignee.email : "Unassigned"}
                    </p>
                    {canWrite && (
                      <div className="mt-1.5 flex gap-2">
                        <form action={updateLeadTaskAction}>
                          {hidden}
                          <input type="hidden" name="taskId" value={t.id} />
                          <input type="hidden" name="status" value="done" />
                          <Button type="submit" variant="secondary" className="h-7 px-2.5 text-xs">
                            Done
                          </Button>
                        </form>
                        <form action={updateLeadTaskAction}>
                          {hidden}
                          <input type="hidden" name="taskId" value={t.id} />
                          <input type="hidden" name="status" value="cancelled" />
                          <Button type="submit" variant="ghost" className="h-7 px-2.5 text-xs">
                            Cancel
                          </Button>
                        </form>
                      </div>
                    )}
                  </li>
                ))}
                {closedTasks.slice(0, 10).map((t) => (
                  <li key={t.id} className="px-1 text-xs text-slate-500" data-task={t.status}>
                    <span className="line-through">{t.title}</span> ·{" "}
                    {t.status === "done"
                      ? `done${t.completedAt ? ` ${formatDateTime(t.completedAt)}` : ""}${t.completedByLabel ? ` by ${t.completedByLabel}` : ""}`
                      : "cancelled"}
                  </li>
                ))}
              </ul>
              {canWrite && (
                <form
                  action={createLeadTaskAction}
                  className="flex flex-col gap-2 border-t border-slate-100 pt-3"
                  aria-label="Add task"
                >
                  {hidden}
                  <input type="hidden" name="tzOffset" value="-330" />
                  <Label htmlFor="task-title">New task</Label>
                  <Input id="task-title" name="title" required maxLength={200} />
                  <div className="grid grid-cols-2 gap-2">
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="task-due" className="text-xs">
                        Due (IST)
                      </Label>
                      <Input id="task-due" name="dueAt" type="datetime-local" />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="task-assignee" className="text-xs">
                        For
                      </Label>
                      <Select id="task-assignee" name="assigneeId" defaultValue={actor.id}>
                        <option value="">Unassigned</option>
                        {assignees.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name || u.email}
                          </option>
                        ))}
                      </Select>
                    </div>
                  </div>
                  <div>
                    <Button type="submit" variant="secondary">
                      Add task
                    </Button>
                  </div>
                </form>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Contacts</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {lead.contacts.length === 0 && (
                <p className="text-sm text-slate-500">No contacts yet.</p>
              )}
              <ul className="flex flex-col gap-2">
                {lead.contacts.map((c) => (
                  <li
                    key={c.id}
                    className="rounded-md border border-slate-200 px-3 py-2 text-sm"
                    data-contact={c.isPrimary ? "primary" : "other"}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-medium text-slate-900">
                        {c.personName ?? "Unnamed"}
                        {c.role && <span className="font-normal text-slate-500"> · {c.role}</span>}
                      </span>
                      {c.isPrimary && <Badge tone="brand">Primary</Badge>}
                    </div>
                    <p className="text-xs text-slate-600">
                      {dnc
                        ? "Channels hidden (do not contact)"
                        : [
                            c.phone && `Phone ${c.phone}`,
                            c.whatsapp && `WhatsApp ${c.whatsapp}`,
                            c.email,
                          ]
                            .filter(Boolean)
                            .join(" · ") || "No channels"}
                    </p>
                    {c.sourceFact && (
                      <p className="text-[11px] text-slate-400">
                        From research fact ({c.sourceFact.field}, {c.sourceFact.verificationStatus})
                      </p>
                    )}
                    {canWrite && (
                      <details className="mt-1.5">
                        <summary className="cursor-pointer text-xs font-semibold text-brand-700">
                          Edit
                        </summary>
                        <form action={saveLeadContactAction} className="mt-2 grid gap-2">
                          {hidden}
                          <input type="hidden" name="contactId" value={c.id} />
                          <Input
                            name="personName"
                            aria-label="Name"
                            placeholder="Name"
                            defaultValue={c.personName ?? ""}
                            maxLength={120}
                          />
                          <Input
                            name="role"
                            aria-label="Role"
                            placeholder="Role"
                            defaultValue={c.role ?? ""}
                            maxLength={80}
                          />
                          <Input
                            name="phone"
                            aria-label="Phone"
                            placeholder="Phone"
                            defaultValue={c.phone ?? ""}
                            maxLength={40}
                          />
                          <Input
                            name="whatsapp"
                            aria-label="WhatsApp"
                            placeholder="WhatsApp"
                            defaultValue={c.whatsapp ?? ""}
                            maxLength={40}
                          />
                          <Input
                            name="email"
                            type="email"
                            aria-label="Email"
                            placeholder="Email"
                            defaultValue={c.email ?? ""}
                            maxLength={254}
                          />
                          <div className="flex gap-2">
                            <Button type="submit" variant="secondary" className="h-8">
                              Save
                            </Button>
                          </div>
                        </form>
                        <div className="mt-2 flex gap-2">
                          {!c.isPrimary && (
                            <form action={saveLeadContactAction}>
                              {hidden}
                              <input type="hidden" name="contactId" value={c.id} />
                              <input type="hidden" name="isPrimary" value="true" />
                              <Button type="submit" variant="ghost" className="h-7 px-2 text-xs">
                                Make primary
                              </Button>
                            </form>
                          )}
                          <form action={deleteLeadContactAction}>
                            {hidden}
                            <input type="hidden" name="contactId" value={c.id} />
                            <Button
                              type="submit"
                              variant="ghost"
                              className="h-7 px-2 text-xs text-red-700"
                            >
                              Remove
                            </Button>
                          </form>
                        </div>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
              {canWrite && (
                <details className="border-t border-slate-100 pt-3">
                  <summary className="cursor-pointer text-sm font-semibold text-brand-700">
                    Add contact
                  </summary>
                  <form
                    action={saveLeadContactAction}
                    className="mt-2 grid gap-2"
                    aria-label="Add contact"
                  >
                    {hidden}
                    <Input name="personName" aria-label="Name" placeholder="Name" maxLength={120} />
                    <Input name="role" aria-label="Role" placeholder="Role" maxLength={80} />
                    <Input name="phone" aria-label="Phone" placeholder="Phone" maxLength={40} />
                    <Input
                      name="whatsapp"
                      aria-label="WhatsApp"
                      placeholder="WhatsApp"
                      maxLength={40}
                    />
                    <Input
                      name="email"
                      type="email"
                      aria-label="Email"
                      placeholder="Email"
                      maxLength={254}
                    />
                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        name="isPrimary"
                        className="h-4 w-4 rounded border-slate-300"
                      />
                      Primary contact
                    </label>
                    <div>
                      <Button type="submit" variant="secondary" className="h-8">
                        Add contact
                      </Button>
                    </div>
                  </form>
                </details>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Tags</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-1.5">
                {lead.tags.length ? (
                  lead.tags.map((t) => (
                    <Link
                      key={t.id}
                      href={`/crm?tag=${encodeURIComponent(t.name)}`}
                      className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-200 hover:bg-slate-200"
                    >
                      {t.name}
                    </Link>
                  ))
                ) : (
                  <span className="text-sm text-slate-500">No tags.</span>
                )}
              </div>
              {canWrite && (
                <form action={setLeadTagsAction} className="flex items-end gap-2" aria-label="Tags">
                  {hidden}
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Label htmlFor="tags">Tags (comma separated)</Label>
                    <Input
                      id="tags"
                      name="tags"
                      maxLength={900}
                      defaultValue={lead.tags.map((t) => t.name).join(", ")}
                    />
                  </div>
                  <Button type="submit" variant="secondary">
                    Save
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>

          <Card id="consent">
            <CardHeader>
              <CardTitle>Consent</CardTitle>
              <CardDescription>
                Recorded on the business, so it also applies outside the CRM.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <dl className="divide-y divide-slate-100">
                <Row label="Status">
                  <Badge tone={dnc ? "red" : "green"}>
                    {CONTACT_STATUS_LABEL[b.contactStatus] ?? b.contactStatus}
                  </Badge>
                </Row>
                <Row label="Lawful basis">{b.lawfulBasisNote}</Row>
              </dl>
              {canWrite && !dnc && (
                <details>
                  <summary className="cursor-pointer text-sm font-semibold text-red-700">
                    Mark do-not-contact
                  </summary>
                  <form
                    action={setLeadDncAction}
                    className="mt-2 flex flex-col gap-2"
                    aria-label="Mark do-not-contact"
                  >
                    {hidden}
                    <Select name="status" aria-label="Status" defaultValue="do_not_contact">
                      <option value="do_not_contact">Do not contact</option>
                      <option value="opted_out">Opted out (they asked)</option>
                    </Select>
                    <Input
                      name="reason"
                      aria-label="Reason"
                      placeholder="Reason (required)"
                      required
                      minLength={3}
                      maxLength={500}
                    />
                    <Input
                      name="lawfulBasisNote"
                      aria-label="Lawful basis note"
                      placeholder="Lawful-basis note (optional)"
                      maxLength={500}
                    />
                    <div>
                      <Button type="submit" variant="danger" className="h-8">
                        Mark do-not-contact
                      </Button>
                    </div>
                  </form>
                </details>
              )}
              {dnc && canClearDnc && (
                <form
                  action={clearLeadDncAction}
                  className="flex flex-col gap-2"
                  aria-label="Clear do-not-contact"
                >
                  {hidden}
                  <Input
                    name="reason"
                    aria-label="Reason for clearing"
                    placeholder="Why it is OK to contact again (required)"
                    required
                    minLength={3}
                    maxLength={500}
                  />
                  <div>
                    <Button type="submit" variant="secondary" className="h-8">
                      Clear do-not-contact
                    </Button>
                  </div>
                </form>
              )}
              {dnc && canWrite && !canClearDnc && (
                <p className="text-xs text-slate-500">Only admins and owners can clear this.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
