import Link from "next/link";
import { CRM_PAGE_SIZE, parseLeadListFilter, type LeadListFilter } from "@kalpix/core";
import { ZodError } from "zod";
import { can } from "@/lib/rbac";
import { formatDateTime } from "@/lib/utils";
import {
  crmQuery,
  formatInr,
  PIPELINE_STAGES,
  PRIORITY_TONE,
  STAGE_TONE,
  stageLabel,
} from "@/lib/crm-display";
import { TIER_TONE, tierLabel, TIERS } from "@/lib/qualification-display";
import { PageHeader } from "@/components/page-header";
import { Flash } from "@/components/flash";
import { EmptyState } from "@/components/empty-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead } from "@/components/ui/table";
import { requirePermission } from "@/server/session";
import { listAssignees, listLeads, listTags, pipelineSummary } from "@/server/crm";
import { ImportPanel } from "./import-panel";

export const metadata = { title: "CRM" };
export const dynamic = "force-dynamic";

export default async function CrmPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePermission("crm:read");
  const actor = session.user;
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const params = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, one(v)]));
  const ok = params.ok;
  let error = params.error;
  let filter: LeadListFilter;
  try {
    filter = parseLeadListFilter(params);
  } catch (err) {
    filter = parseLeadListFilter({});
    error =
      err instanceof ZodError
        ? `Filters ignored: ${err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
        : "Filters ignored";
  }
  const canExport = can(actor.role, "crm:export");
  const canImport = can(actor.role, "crm:import");
  const [list, summary, assignees, tags] = await Promise.all([
    listLeads(actor, filter),
    pipelineSummary(actor),
    listAssignees(actor),
    listTags(actor),
  ]);
  const { page: _p, ...activeFilter } = filter;
  void _p;
  const filtered = Object.values(activeFilter).some((v) => v !== undefined);
  const from = list.total === 0 ? 0 : (filter.page - 1) * CRM_PAGE_SIZE + 1;
  const to = Math.min(filter.page * CRM_PAGE_SIZE, list.total);
  const anyMock = list.leads.some((l) => l.business.name.startsWith("MOCK"));

  return (
    <>
      <PageHeader
        title="CRM"
        description="Leads promoted from qualification, added by hand or imported. Each lead belongs to one business; do-not-contact is recorded on the business and blocks every outreach stage. No messages are sent from here."
        actions={
          canExport ? (
            <a
              href={`/api/crm/leads/export${crmQuery(activeFilter)}`}
              className="inline-flex h-9 items-center rounded-md border border-slate-300 bg-white px-3.5 text-sm font-semibold text-slate-800 hover:bg-slate-50"
            >
              Export CSV{filtered ? " (filtered)" : ""}
            </a>
          ) : undefined
        }
      />
      <Flash ok={ok} error={error} />

      <section aria-label="Pipeline" className="mb-6">
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 xl:grid-cols-9">
          {PIPELINE_STAGES.map((s) => {
            const active = filter.stage === s;
            return (
              <Link
                key={s}
                href={`/crm${crmQuery(activeFilter, { stage: active ? undefined : s, page: undefined })}`}
                className={`flex flex-col justify-between rounded-lg border bg-white px-3 py-2.5 transition-colors hover:border-brand-600 ${active ? "border-brand-600 ring-2 ring-brand-100" : "border-slate-200"}`}
                data-stage={s}
              >
                <span className="block text-[10.5px] font-semibold uppercase leading-tight tracking-wide text-slate-500">
                  {stageLabel(s)}
                </span>
                <span className="font-display text-xl font-semibold tabular-nums text-slate-900">
                  {summary.byStage[s]}
                </span>
              </Link>
            );
          })}
        </div>
        <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
          <span>{summary.total} leads in total</span>
          <Link
            href={`/crm${crmQuery({ overdue: true })}`}
            className={summary.overdue ? "font-semibold text-red-700" : ""}
          >
            {summary.overdue} overdue
          </Link>
          <Link href={`/crm${crmQuery({ stale: true })}`}>
            {summary.stale} stale (no activity in {summary.staleDays} days)
          </Link>
          <span>{summary.doNotContact} do-not-contact / opted out</span>
        </p>
      </section>

      <form className="mb-4 flex flex-wrap items-end gap-2" aria-label="Filter leads">
        <div className="flex flex-col gap-1">
          <Label htmlFor="f-q">Search</Label>
          <Input
            id="f-q"
            name="q"
            defaultValue={filter.q ?? ""}
            placeholder="Business, phone, contact"
            maxLength={100}
            className="w-48"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="f-stage">Stage</Label>
          <Select id="f-stage" name="stage" defaultValue={filter.stage ?? ""} className="w-40">
            <option value="">All stages</option>
            {PIPELINE_STAGES.map((s) => (
              <option key={s} value={s}>
                {stageLabel(s)}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="f-assignee">Assignee</Label>
          <Select
            id="f-assignee"
            name="assignee"
            defaultValue={filter.assignee ?? ""}
            className="w-48"
          >
            <option value="">Anyone</option>
            <option value="me">Me</option>
            <option value="none">Unassigned</option>
            {assignees.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name || u.email}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="f-tier">Tier</Label>
          <Select id="f-tier" name="tier" defaultValue={filter.tier ?? ""} className="w-32">
            <option value="">Any</option>
            {TIERS.map((t) => (
              <option key={t} value={t}>
                {tierLabel(t)}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="f-tag">Tag</Label>
          <Select id="f-tag" name="tag" defaultValue={filter.tag ?? ""} className="w-36">
            <option value="">Any</option>
            {tags.map((t) => (
              <option key={t.id} value={t.name}>
                {t.name} ({t.leadCount})
              </option>
            ))}
          </Select>
        </div>
        <label className="flex h-9 items-center gap-2 text-sm font-medium text-slate-700">
          <input
            type="checkbox"
            name="overdue"
            value="yes"
            defaultChecked={filter.overdue === true}
            className="h-4 w-4 rounded border-slate-300"
          />
          Overdue only
        </label>
        <Button type="submit" variant="secondary">
          Apply
        </Button>
        <Link href="/crm" className="self-end pb-2 text-sm font-semibold text-slate-500">
          Reset
        </Link>
      </form>

      {anyMock && (
        <p
          role="note"
          className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-900"
        >
          Some leads are MOCK test data. They are not real businesses.
        </p>
      )}

      {list.leads.length === 0 ? (
        <EmptyState
          icon="Users"
          title={filtered ? "No leads match these filters" : "No leads yet"}
          body={
            filtered
              ? "Change or reset the filters."
              : "Promote hot and warm businesses from Lead Qualification, add one from a business page, or import a CSV."
          }
        >
          {!filtered && (
            <Link href="/leads" className="text-sm font-semibold text-brand-700">
              Go to Lead Qualification →
            </Link>
          )}
        </EmptyState>
      ) : (
        <Card>
          <Table>
            <THead>
              <tr>
                <TH className="px-3">Business</TH>
                <TH className="px-3">Stage</TH>
                <TH className="px-2">Tier</TH>
                <TH className="px-3">Assignee</TH>
                <TH className="px-2">Priority</TH>
                <TH className="px-3">Next follow-up (IST)</TH>
                <TH className="px-2 text-right">Value</TH>
                <TH className="px-3">Tags</TH>
              </tr>
            </THead>
            <TBody>
              {list.leads.map((l) => (
                <tr key={l.id} data-lead={l.id}>
                  <TD className="max-w-[16rem] px-3">
                    <Link
                      href={`/crm/leads/${l.id}`}
                      className="font-medium text-slate-900 hover:text-brand-700"
                    >
                      {l.business.name}
                    </Link>
                    <span className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-slate-500">
                      {l.business.city ?? "—"}
                      {l.business.contactStatus !== "ok" && (
                        <Badge tone="red" title="Do not contact">
                          DNC
                        </Badge>
                      )}
                      {l.health === "stale" && (
                        <Badge tone="amber" title={`No activity for ${l.daysSinceActivity} days`}>
                          Stale
                        </Badge>
                      )}
                    </span>
                  </TD>
                  <TD className="px-3">
                    <Badge tone={STAGE_TONE[l.stage]}>{stageLabel(l.stage)}</Badge>
                  </TD>
                  <TD className="whitespace-nowrap px-2">
                    {l.business.latestTier ? (
                      <Badge tone={TIER_TONE[l.business.latestTier] ?? "neutral"}>
                        {tierLabel(l.business.latestTier)} · {l.business.latestScore ?? "—"}
                      </Badge>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </TD>
                  <TD className="max-w-[10rem] truncate px-3 text-xs">
                    {l.assignee ? (
                      <span title={l.assignee.email}>{l.assignee.name || l.assignee.email}</span>
                    ) : (
                      <span className="text-slate-400">Unassigned</span>
                    )}
                  </TD>
                  <TD className="px-2">
                    <Badge tone={PRIORITY_TONE[l.priority] ?? "neutral"}>{l.priority}</Badge>
                  </TD>
                  <TD className="whitespace-nowrap px-3 text-xs">
                    {l.nextFollowUpAt ? formatDateTime(l.nextFollowUpAt) : "—"}
                    {l.overdue && (
                      <Badge tone="red" className="ml-1.5">
                        Overdue
                      </Badge>
                    )}
                    {l.openTaskCount > 0 && (
                      <span className="block text-slate-500">
                        {l.openTaskCount} open task{l.openTaskCount === 1 ? "" : "s"}
                        {l.overdueTaskCount > 0 ? `, ${l.overdueTaskCount} overdue` : ""}
                      </span>
                    )}
                  </TD>
                  <TD className="whitespace-nowrap px-2 text-right text-xs tabular-nums">
                    {formatInr(l.valueEstimatePaise)}
                  </TD>
                  <TD className="max-w-[12rem] px-3">
                    <span className="flex flex-wrap gap-1">
                      {l.tags.map((t) => (
                        <Badge key={t} tone="neutral" className="font-medium">
                          {t}
                        </Badge>
                      ))}
                    </span>
                  </TD>
                </tr>
              ))}
            </TBody>
          </Table>
        </Card>
      )}

      <div className="mt-4 flex items-center justify-between text-sm text-slate-500">
        <span>
          {list.total === 0 ? "0 leads" : `${from}–${to} of ${list.total} leads`} · soonest
          follow-up first
        </span>
        <div className="flex gap-3">
          {filter.page > 1 && (
            <Link
              className="font-semibold text-brand-700"
              href={`/crm${crmQuery(activeFilter, { page: String(filter.page - 1) })}`}
            >
              Previous
            </Link>
          )}
          {filter.page * CRM_PAGE_SIZE < list.total && (
            <Link
              className="font-semibold text-brand-700"
              href={`/crm${crmQuery(activeFilter, { page: String(filter.page + 1) })}`}
            >
              Next
            </Link>
          )}
        </div>
      </div>

      {canImport && (
        <Card className="mt-8">
          <CardHeader>
            <CardTitle>Import leads from CSV</CardTitle>
            <CardDescription>
              Admins and owners. Preview first: the dry run checks every row and writes nothing.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ImportPanel />
          </CardContent>
        </Card>
      )}
    </>
  );
}
