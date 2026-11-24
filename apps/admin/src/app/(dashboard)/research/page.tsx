import Link from "next/link";
import { randomUUID } from "node:crypto";
import { isKalpixCategory, KALPIX_CATEGORIES } from "@kalpix/core";
import { categoryLabel } from "@kalpix/providers";
import { db } from "@/lib/db";
import { can } from "@/lib/rbac";
import { formatDateTime } from "@/lib/utils";
import { canRetryRun, isActiveRun, RUN_STATUS_TONE } from "@/lib/discovery-display";
import {
  describeScope,
  outcomeCounts,
  parseResearchPrefill,
  RESEARCH_LIMIT_MAX,
  RESEARCH_OUTCOMES,
  RESEARCH_PROVIDER_OPTION_LABEL,
  RESEARCH_STATUS_TONE,
  researchProviderLabel,
  researchStatusLabel,
  selectableResearchProviders,
} from "@/lib/research-display";
import { PageHeader } from "@/components/page-header";
import { Flash } from "@/components/flash";
import { EmptyState } from "@/components/empty-state";
import { AutoRefresh } from "@/components/auto-refresh";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead } from "@/components/ui/table";
import { requirePermission } from "@/server/session";
import { researchReadiness } from "@/server/research";
import { cancelResearchRun, retryResearchRun, startResearchRun } from "@/server/actions/research";

export const metadata = { title: "Business Research" };
export const dynamic = "force-dynamic";

const OUTCOME_HEAD: Record<string, string> = {
  ok: "OK",
  no_website: "No site",
  broken: "Broken",
  blocked: "Blocked",
  error: "Error",
};

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start justify-between gap-2">
      <span className="text-slate-600">{children}</span>
      {ok ? <Badge tone="green">Yes</Badge> : <Badge tone="red">No</Badge>}
    </li>
  );
}

export default async function ResearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePermission("dashboard:read");
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const ok = one(sp.ok);
  const error = one(sp.error);
  const prefill = parseResearchPrefill(sp, isKalpixCategory);
  const canRun = can(session.user.role, "research:run");

  const [readiness, http, runs, discoveryRuns] = await Promise.all([
    researchReadiness(),
    researchReadiness("http"),
    db.researchRun.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
    db.discoveryRun.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, area: true, areaDisplayName: true, provider: true, createdAt: true },
    }),
  ]);
  // Scope labels for runs that point at older discovery runs not in the select list.
  const missing = [
    ...new Set(
      runs
        .map((r) => r.discoveryRunId)
        .filter((x): x is string => !!x && !discoveryRuns.some((d) => d.id === x)),
    ),
  ];
  const extraRuns = missing.length
    ? await db.discoveryRun.findMany({
        where: { id: { in: missing } },
        select: { id: true, area: true, areaDisplayName: true, provider: true, createdAt: true },
      })
    : [];
  const runLabel = (id: string) => {
    const d = [...discoveryRuns, ...extraRuns].find((x) => x.id === id);
    return d ? `${d.areaDisplayName ?? d.area} · ${formatDateTime(d.createdAt)}` : undefined;
  };

  const anyActive = runs.some((r) => isActiveRun(r.status));
  const isMock = readiness.kind === "mock";
  const providerOptions = selectableResearchProviders(process.env.APP_ENV);
  const defaultProvider = readiness.kind ?? "http";
  const maxPages = Number(process.env.RESEARCH_MAX_PAGES || "5");
  const hostDelay = Math.max(2000, Number(process.env.RESEARCH_HOST_DELAY_MS || "2000"));
  const prefilledRunMissing =
    prefill.discoveryRunId && !discoveryRuns.some((d) => d.id === prefill.discoveryRunId);

  return (
    <>
      <PageHeader
        title="Business Research"
        description="Read each business's own website (robots.txt respected, polite rate limits) and record contact facts and plain website observations with their source. Runs are processed by the background worker (pnpm worker). No scoring happens here."
        actions={<AutoRefresh active={anyActive} />}
      />
      <Flash ok={ok} error={error} />

      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Readiness</CardTitle>
            <CardDescription>Default for new runs, set by RESEARCH_PROVIDER.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-slate-800">
                {readiness.providerId
                  ? researchProviderLabel(readiness.providerId)
                  : "Not configured"}
              </span>
              {readiness.ready ? (
                <Badge tone="green">Ready</Badge>
              ) : (
                <Badge tone="red">Not ready</Badge>
              )}
            </div>
            {isMock && (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
                MOCK provider: no website is fetched and every fact is fake test data marked MOCK.
              </p>
            )}
            <div className="rounded-md border border-slate-200 px-3 py-2">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-700">
                  HTTP + schema.org extractor
                </span>
                {http.ready ? (
                  <Badge tone="green">Ready</Badge>
                ) : (
                  <Badge tone="red">Not ready</Badge>
                )}
              </div>
              <ul className="flex flex-col gap-1.5 text-xs">
                <Check ok={Boolean(http.enabled)}>
                  Enabled by the owner (AI Provider Settings)
                </Check>
                <Check ok={http.contactSet}>RESEARCH_USER_AGENT_CONTACT set</Check>
              </ul>
            </div>
            {readiness.problems.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-xs text-red-700">
                {readiness.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-500">
              <dt>Pages per site</dt>
              <dd className="text-right">{Number.isFinite(maxPages) ? maxPages : 5}</dd>
              <dt>Delay per host</dt>
              <dd className="text-right">
                {Number.isFinite(hostDelay) ? (hostDelay / 1000).toFixed(1) : "2.0"} s
              </dd>
              <dt>Max per run</dt>
              <dd className="text-right">{RESEARCH_LIMIT_MAX} businesses</dd>
            </dl>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Start a run</CardTitle>
            <CardDescription>
              Research every business from one discovery run, or businesses matching a filter.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {canRun ? (
              <form action={startResearchRun} className="flex flex-col gap-4">
                <input type="hidden" name="idempotencyKey" value={randomUUID()} />
                <fieldset className="flex flex-col gap-3">
                  <legend className="sr-only">Scope</legend>
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
                    <input
                      type="radio"
                      name="scope"
                      value="discovery_run"
                      defaultChecked={prefill.scope === "discovery_run"}
                      className="h-4 w-4 border-slate-300"
                    />
                    Businesses from a discovery run
                  </label>
                  <div className="pl-6">
                    <Label htmlFor="discoveryRunId" className="sr-only">
                      Discovery run
                    </Label>
                    <Select
                      id="discoveryRunId"
                      name="discoveryRunId"
                      defaultValue={prefill.discoveryRunId}
                    >
                      <option value="">Choose a discovery run…</option>
                      {prefilledRunMissing && (
                        <option value={prefill.discoveryRunId}>
                          {runLabel(prefill.discoveryRunId) ?? prefill.discoveryRunId}
                        </option>
                      )}
                      {discoveryRuns.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.provider === "mock-discovery" ? "[MOCK] " : ""}
                          {(d.areaDisplayName ?? d.area).slice(0, 50)} ·{" "}
                          {formatDateTime(d.createdAt)}
                        </option>
                      ))}
                    </Select>
                  </div>

                  <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
                    <input
                      type="radio"
                      name="scope"
                      value="filter"
                      defaultChecked={prefill.scope === "filter"}
                      className="h-4 w-4 border-slate-300"
                    />
                    Businesses matching a filter
                  </label>
                  <div className="grid gap-3 pl-6 sm:grid-cols-4">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="category">Category</Label>
                      <Select id="category" name="category" defaultValue={prefill.category}>
                        <option value="">All</option>
                        {KALPIX_CATEGORIES.map((c) => (
                          <option key={c} value={c}>
                            {categoryLabel(c)}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="website">Website</Label>
                      <Select id="website" name="website" defaultValue={prefill.website}>
                        <option value="">Any</option>
                        <option value="yes">Has website</option>
                        <option value="no">No website</option>
                      </Select>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="staleAfterDays">Not researched in (days)</Label>
                      <Input
                        id="staleAfterDays"
                        name="staleAfterDays"
                        type="number"
                        min={1}
                        max={3650}
                        step={1}
                        placeholder="Any"
                        defaultValue={prefill.staleAfterDays}
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="limit">Limit (max {RESEARCH_LIMIT_MAX})</Label>
                      <Input
                        id="limit"
                        name="limit"
                        type="number"
                        min={1}
                        max={RESEARCH_LIMIT_MAX}
                        step={1}
                        required
                        defaultValue={prefill.limit}
                      />
                    </div>
                  </div>
                </fieldset>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex w-64 flex-col gap-1.5">
                    <Label htmlFor="provider">Provider</Label>
                    <Select id="provider" name="provider" defaultValue={defaultProvider}>
                      {providerOptions.map((p) => (
                        <option key={p} value={p}>
                          {RESEARCH_PROVIDER_OPTION_LABEL[p] ?? p}
                          {p === defaultProvider ? " (default)" : ""}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <Button type="submit">Queue run</Button>
                </div>
                <p className="text-xs text-slate-500">
                  “Not researched in” also includes businesses never researched. Leave it blank to
                  research matching businesses again regardless of when they were last done.
                </p>
              </form>
            ) : (
              <p className="text-sm text-slate-500">
                You can view runs and their results. Starting a run needs the operator role or
                above.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {runs.length === 0 ? (
        <EmptyState
          icon="FileSearch"
          title="No research runs yet"
          body="Queued runs appear here with their progress and how each website turned out."
        />
      ) : (
        <Card>
          <Table className="min-w-[60rem]">
            <THead>
              <tr>
                <TH className="px-3">Queued (IST)</TH>
                <TH className="px-3">Scope</TH>
                <TH className="px-3">Status</TH>
                {RESEARCH_OUTCOMES.map((o) => (
                  <TH key={o} className="px-2 text-right" title={researchStatusLabel(o)}>
                    {OUTCOME_HEAD[o]}
                  </TH>
                ))}
                <TH className="px-2 text-right" title="Facts written (new)">
                  Facts
                </TH>
                <TH className="px-2 text-right" title="Businesses with conflicting values">
                  Confl.
                </TH>
                <TH className="px-3 text-right">Actions</TH>
              </tr>
            </THead>
            <TBody>
              {runs.map((r) => {
                const mock = r.provider === "mock-research";
                return (
                  <tr key={r.id}>
                    <TD className="whitespace-nowrap px-3 text-xs">
                      {formatDateTime(r.createdAt)}
                      <span
                        className="block max-w-[9rem] truncate text-slate-400"
                        title={r.startedByLabel}
                      >
                        {r.startedByLabel}
                      </span>
                    </TD>
                    <TD className="px-3">
                      <span className="block max-w-[16rem] text-sm text-slate-900">
                        {describeScope(r, {
                          discoveryRunLabel: runLabel,
                          categoryLabel: (c) => categoryLabel(c),
                        })}
                      </span>
                      <span className="text-xs text-slate-500">
                        {mock ? (
                          <Badge tone="amber">MOCK</Badge>
                        ) : (
                          researchProviderLabel(r.provider)
                        )}
                      </span>
                      {r.error && (
                        <span className="mt-1 block max-w-[16rem] break-words text-xs text-red-700">
                          {r.error}
                        </span>
                      )}
                    </TD>
                    <TD className="px-3">
                      <Badge tone={RUN_STATUS_TONE[r.status] ?? "neutral"}>{r.status}</Badge>
                      <span className="mt-1 block whitespace-nowrap text-xs text-slate-500">
                        {r.resolvedAt ? `${r.processedCount}/${r.totalCount} done` : "Not started"}
                      </span>
                    </TD>
                    {outcomeCounts(r).map((o) => (
                      <TD key={o.outcome} className="px-2 text-right tabular-nums">
                        {o.count > 0 && o.outcome !== "ok" && o.outcome !== "no_website" ? (
                          <span
                            className={
                              RESEARCH_STATUS_TONE[o.outcome] === "red"
                                ? "font-semibold text-red-700"
                                : "font-semibold text-amber-800"
                            }
                          >
                            {o.count}
                          </span>
                        ) : (
                          o.count
                        )}
                      </TD>
                    ))}
                    <TD className="whitespace-nowrap px-2 text-right tabular-nums">
                      {r.factCount}
                      <span className="block text-xs text-slate-500">{r.newFactCount} new</span>
                    </TD>
                    <TD className="px-2 text-right tabular-nums">
                      {r.conflictCount > 0 ? (
                        <span className="font-semibold text-amber-800">{r.conflictCount}</span>
                      ) : (
                        0
                      )}
                    </TD>
                    <TD className="px-3 text-right">
                      <div className="flex flex-col items-end gap-1">
                        {r.discoveryRunId && (
                          <Link
                            href={`/businesses?run=${r.discoveryRunId}`}
                            className="inline-flex h-8 items-center px-2 text-sm font-semibold text-brand-700"
                          >
                            Businesses
                          </Link>
                        )}
                        {canRun && canRetryRun(r.status) && (
                          <form action={retryResearchRun}>
                            <input type="hidden" name="id" value={r.id} />
                            <Button type="submit" variant="secondary" className="h-8">
                              Retry
                            </Button>
                          </form>
                        )}
                        {canRun && isActiveRun(r.status) && (
                          <form action={cancelResearchRun}>
                            <input type="hidden" name="id" value={r.id} />
                            <Button type="submit" variant="ghost" className="h-8">
                              Cancel
                            </Button>
                          </form>
                        )}
                      </div>
                    </TD>
                  </tr>
                );
              })}
            </TBody>
          </Table>
        </Card>
      )}
    </>
  );
}
