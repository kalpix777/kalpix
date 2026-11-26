import Link from "next/link";
import { randomUUID } from "node:crypto";
import { isKalpixCategory, KALPIX_CATEGORIES } from "@kalpix/core";
import { categoryLabel } from "@kalpix/providers";
import { db } from "@/lib/db";
import { can } from "@/lib/rbac";
import { formatDateTime } from "@/lib/utils";
import { canRetryRun, isActiveRun, parsePage, RUN_STATUS_TONE } from "@/lib/discovery-display";
import {
  AI_PROVIDER_LABEL,
  aiProviderLabel,
  CHANNEL_LABEL,
  contactChannels,
  describeQualificationScope,
  LEADS_PAGE_SIZE,
  leadsQuery,
  leadsWhere,
  parseLeadsFilters,
  parseReasons,
  QUALIFICATION_DEFAULT_LIMIT,
  QUALIFICATION_LIMIT_MAX,
  selectableAiKinds,
  TIER_TONE,
  tierCounts,
  tierLabel,
  TIERS,
  topReason,
} from "@/lib/qualification-display";
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
import { aiReadiness, type AiProviderStatus } from "@/server/qualification";
import {
  cancelQualificationRun,
  retryQualificationRun,
  startQualificationRun,
} from "@/server/actions/qualification";
import { createManualLeadAction, promoteLeadsAction } from "@/server/actions/crm";

export const metadata = { title: "Lead Qualification" };
export const dynamic = "force-dynamic";

function Check({ ok, children }: { ok: boolean | null; children: React.ReactNode }) {
  if (ok === null) return null;
  return (
    <li className="flex items-start justify-between gap-2">
      <span className="text-slate-600">{children}</span>
      {ok ? <Badge tone="green">Yes</Badge> : <Badge tone="red">No</Badge>}
    </li>
  );
}

function ProviderBox({ p }: { p: AiProviderStatus }) {
  return (
    <div className="rounded-md border border-slate-200 px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-slate-700">
          {p.kind === "mock" ? "MOCK model" : p.name}
        </span>
        {p.ready ? <Badge tone="green">Ready</Badge> : <Badge tone="neutral">Not ready</Badge>}
      </div>
      <ul className="flex flex-col gap-1 text-xs">
        <Check ok={p.ownerEnabled}>Enabled by the owner</Check>
        <Check ok={p.termsConfirmed}>Commercial terms confirmed</Check>
        {p.keyName && (
          <Check ok={p.keyPresent}>
            <code className="text-[11px]">{p.keyName}</code> present
          </Check>
        )}
      </ul>
      {p.kind === "gemini" && p.notice && (
        <p className="mt-2 rounded bg-amber-50 px-2 py-1.5 text-[11px] leading-snug text-amber-900">
          {p.notice}
        </p>
      )}
      {p.kind === "mock" && !p.ready && p.problems.length > 0 && (
        <p className="mt-1 text-[11px] text-slate-500">{p.problems.join(" ")}</p>
      )}
    </div>
  );
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePermission("dashboard:read");
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const ok = one(sp.ok);
  const error = one(sp.error);
  const canRun = can(session.user.role, "qualification:run");
  const canCrm = can(session.user.role, "crm:write");
  const canCrmRead = can(session.user.role, "crm:read");
  const filters = parseLeadsFilters(sp, isKalpixCategory);
  const page = parsePage(one(sp.page));
  const where = leadsWhere(filters);

  const [readiness, runs, discoveryRuns, researchRuns, leads, leadTotal, tierGroups] =
    await Promise.all([
      aiReadiness(),
      db.qualificationRun.findMany({ orderBy: { createdAt: "desc" }, take: 30 }),
      db.discoveryRun.findMany({
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { id: true, area: true, areaDisplayName: true, provider: true, createdAt: true },
      }),
      db.researchRun.findMany({
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { id: true, provider: true, scopeType: true, totalCount: true, createdAt: true },
      }),
      db.business.findMany({
        where,
        orderBy: [{ latestScore: "desc" }, { qualifiedAt: "desc" }, { name: "asc" }],
        take: LEADS_PAGE_SIZE,
        skip: (page - 1) * LEADS_PAGE_SIZE,
        select: {
          id: true,
          name: true,
          category: true,
          city: true,
          locality: true,
          source: true,
          latestScore: true,
          latestTier: true,
          qualifiedAt: true,
          contactStatus: true,
          lead: { select: { id: true } },
          qualifications: {
            orderBy: { qualifiedAt: "desc" },
            take: 1,
            select: { reasons: true, isMock: true, aiStatus: true, aiIsMock: true },
          },
        },
      }),
      db.business.count({ where }),
      db.business.groupBy({
        by: ["latestTier"],
        where: { latestTier: { not: null } },
        _count: { _all: true },
      }),
    ]);

  const tierTotal = (t: string) => tierGroups.find((g) => g.latestTier === t)?._count._all ?? 0;
  const drLabel = (id: string) => {
    const d = discoveryRuns.find((x) => x.id === id);
    return d ? `${d.areaDisplayName ?? d.area} · ${formatDateTime(d.createdAt)}` : undefined;
  };
  const rrLabel = (id: string) => {
    const r = researchRuns.find((x) => x.id === id);
    return r ? `${formatDateTime(r.createdAt)} · ${r.totalCount} businesses` : undefined;
  };
  const anyActive = runs.some((r) => isActiveRun(r.status));
  const selectable = selectableAiKinds(readiness.providers, process.env.APP_ENV);
  const anyAiReady = selectable.length > 0;
  const defaultAi =
    readiness.defaultKind !== "none" && selectable.includes(readiness.defaultKind)
      ? readiness.defaultKind
      : "none";
  const mockDefault = readiness.defaultKind === "mock";
  const anyMockLead = leads.some((l) => l.qualifications[0]?.isMock || l.source === "mock");
  const from = leadTotal === 0 ? 0 : (page - 1) * LEADS_PAGE_SIZE + 1;
  const to = Math.min(page * LEADS_PAGE_SIZE, leadTotal);

  return (
    <>
      <PageHeader
        title="Lead Qualification"
        description="Verify each business's facts, then score it with transparent rules (website opportunity, contactability, category fit). The score and tier come only from the rules; optional AI adds a summary and pitch idea that are never verified. Runs are processed by the background worker (pnpm worker)."
        actions={<AutoRefresh active={anyActive} />}
      />
      <Flash ok={ok} error={error} />

      {mockDefault && (
        <p
          role="note"
          className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-900"
        >
          MOCK model is the default AI provider: AI text is fixture output starting with “MOCK”, not
          a model&apos;s judgement. Never use it with real leads.
        </p>
      )}

      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>AI readiness</CardTitle>
            <CardDescription>
              Optional. Default for new runs:{" "}
              <span className="font-semibold text-slate-700">
                {AI_PROVIDER_LABEL[readiness.defaultKind] ?? readiness.defaultKind}
              </span>{" "}
              (QUALIFICATION_AI_PROVIDER).
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2.5 text-sm">
            {readiness.defaultError && (
              <p className="text-xs text-red-700">{readiness.defaultError}</p>
            )}
            {readiness.providers.map((p) => (
              <ProviderBox key={p.kind} p={p} />
            ))}
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-500">
              <dt>Rules version</dt>
              <dd className="text-right">{readiness.rulesVersion}</dd>
              <dt>Prompt version</dt>
              <dd className="text-right">{readiness.promptVersion}</dd>
            </dl>
            <p className="text-xs text-slate-500">
              Key values are never shown. The owner enables providers in AI Provider Settings.
            </p>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Start a run</CardTitle>
            <CardDescription>
              Verify and qualify businesses from a discovery run, a research run, or a filter.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {canRun ? (
              <form action={startQualificationRun} className="flex flex-col gap-4">
                <input type="hidden" name="idempotencyKey" value={randomUUID()} />
                <fieldset className="flex flex-col gap-3">
                  <legend className="sr-only">Scope</legend>
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
                    <input
                      type="radio"
                      name="scope"
                      value="discovery_run"
                      className="h-4 w-4 border-slate-300"
                    />
                    Businesses from a discovery run
                  </label>
                  <div className="pl-6">
                    <Label htmlFor="discoveryRunId" className="sr-only">
                      Discovery run
                    </Label>
                    <Select id="discoveryRunId" name="discoveryRunId" defaultValue="">
                      <option value="">Choose a discovery run…</option>
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
                      value="research_run"
                      className="h-4 w-4 border-slate-300"
                    />
                    Businesses from a research run
                  </label>
                  <div className="pl-6">
                    <Label htmlFor="researchRunId" className="sr-only">
                      Research run
                    </Label>
                    <Select id="researchRunId" name="researchRunId" defaultValue="">
                      <option value="">Choose a research run…</option>
                      {researchRuns.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.provider === "mock-research" ? "[MOCK] " : ""}
                          {formatDateTime(r.createdAt)} · {r.totalCount} businesses ·{" "}
                          {r.scopeType.replace("_", " ")}
                        </option>
                      ))}
                    </Select>
                  </div>

                  <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
                    <input
                      type="radio"
                      name="scope"
                      value="filter"
                      defaultChecked
                      className="h-4 w-4 border-slate-300"
                    />
                    Businesses matching a filter
                  </label>
                  <div className="grid gap-3 pl-6 sm:grid-cols-3">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="category">Category</Label>
                      <Select id="category" name="category" defaultValue="">
                        <option value="">All</option>
                        {KALPIX_CATEGORIES.map((c) => (
                          <option key={c} value={c}>
                            {categoryLabel(c)}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="city">City</Label>
                      <Input id="city" name="city" maxLength={100} placeholder="Any" />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="website">Website</Label>
                      <Select id="website" name="website" defaultValue="">
                        <option value="">Any</option>
                        <option value="yes">Has website</option>
                        <option value="no">No website</option>
                      </Select>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="tier">Current tier</Label>
                      <Select id="tier" name="tier" defaultValue="">
                        <option value="">Any</option>
                        {TIERS.map((t) => (
                          <option key={t} value={t}>
                            {tierLabel(t)}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="staleAfterDays">Not qualified in (days)</Label>
                      <Input
                        id="staleAfterDays"
                        name="staleAfterDays"
                        type="number"
                        min={1}
                        max={3650}
                        step={1}
                        placeholder="Any"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="limit">Limit (max {QUALIFICATION_LIMIT_MAX})</Label>
                      <Input
                        id="limit"
                        name="limit"
                        type="number"
                        min={1}
                        max={QUALIFICATION_LIMIT_MAX}
                        step={1}
                        required
                        defaultValue={QUALIFICATION_DEFAULT_LIMIT}
                      />
                    </div>
                  </div>
                </fieldset>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex w-72 flex-col gap-1.5">
                    <Label htmlFor="ai">AI suggestions</Label>
                    <Select
                      id="ai"
                      name="ai"
                      defaultValue={defaultAi}
                      disabled={!anyAiReady}
                      title={anyAiReady ? undefined : "No AI provider is ready"}
                    >
                      <option value="none">Off (rules only)</option>
                      {readiness.providers.map((p) => (
                        <option key={p.kind} value={p.kind} disabled={!selectable.includes(p.kind)}>
                          On: {AI_PROVIDER_LABEL[p.kind]}
                          {selectable.includes(p.kind) ? "" : " (not ready)"}
                        </option>
                      ))}
                    </Select>
                    {!anyAiReady && <input type="hidden" name="ai" value="none" />}
                  </div>
                  <Button type="submit">Queue run</Button>
                </div>
                <p className="text-xs text-slate-500">
                  {anyAiReady
                    ? "AI never changes the score or tier, and is skipped for disqualified businesses. Phone numbers and emails are masked before any AI call."
                    : "AI is off: no provider is ready. Runs score with the rules only."}{" "}
                  “Not qualified in” also includes businesses never qualified.
                </p>
              </form>
            ) : (
              <p className="text-sm text-slate-500">
                You can view runs and ranked leads. Starting a run needs the operator role or above.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <h2 className="mb-3 text-base font-semibold text-slate-900">Runs</h2>
      {runs.length === 0 ? (
        <EmptyState
          icon="Target"
          title="No qualification runs yet"
          body="Queued runs appear here with their progress, tier counts and verification results."
        />
      ) : (
        <Card className="mb-8">
          <Table className="min-w-[60rem]">
            <THead>
              <tr>
                <TH className="px-3">Queued (IST)</TH>
                <TH className="px-3">Scope</TH>
                <TH className="px-3">Status</TH>
                {(["hot", "warm", "cold", "disqualified"] as const).map((t) => (
                  <TH key={t} className="px-2 text-right" title={tierLabel(t)}>
                    {t === "disqualified" ? "DQ" : tierLabel(t)}
                  </TH>
                ))}
                <TH className="px-2 text-right" title="Facts verified / invalid (of checked)">
                  Facts ✓/✗
                </TH>
                <TH className="px-2 text-right" title="AI ok / error, tokens in+out">
                  AI
                </TH>
                <TH className="px-3 text-right">Actions</TH>
              </tr>
            </THead>
            <TBody>
              {runs.map((r) => {
                const mockAi = r.aiProvider === "mock-model";
                const tokens = r.aiInputTokens + r.aiOutputTokens;
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
                      <span className="block max-w-[15rem] text-sm text-slate-900">
                        {describeQualificationScope(r, {
                          discoveryRunLabel: drLabel,
                          researchRunLabel: rrLabel,
                          categoryLabel: (c) => categoryLabel(c),
                        })}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-slate-500">
                        {r.aiEnabled ? (
                          mockAi ? (
                            <Badge tone="amber">AI: MOCK</Badge>
                          ) : (
                            <span>AI: {aiProviderLabel(r.aiProvider)}</span>
                          )
                        ) : (
                          <span>Rules only</span>
                        )}
                        <span className="text-slate-400">· {r.rulesVersion}</span>
                      </span>
                      {r.error && (
                        <span className="mt-1 block max-w-[15rem] break-words text-xs text-red-700">
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
                    {tierCounts(r).map((t) => (
                      <TD key={t.tier} className="px-2 text-right tabular-nums">
                        {t.count > 0 && (t.tier === "hot" || t.tier === "warm") ? (
                          <span
                            className={
                              t.tier === "hot"
                                ? "font-semibold text-red-700"
                                : "font-semibold text-amber-800"
                            }
                          >
                            {t.count}
                          </span>
                        ) : (
                          t.count
                        )}
                      </TD>
                    ))}
                    <TD className="whitespace-nowrap px-2 text-right tabular-nums">
                      <span className="text-emerald-700">{r.factsVerifiedCount}</span>
                      {" / "}
                      <span className={r.factsInvalidCount ? "font-semibold text-red-700" : ""}>
                        {r.factsInvalidCount}
                      </span>
                      <span className="block text-xs text-slate-500">of {r.factsCheckedCount}</span>
                    </TD>
                    <TD className="whitespace-nowrap px-2 text-right tabular-nums text-xs">
                      {r.aiEnabled ? (
                        <>
                          <span className="text-emerald-700">{r.aiOkCount} ok</span>
                          {r.aiErrorCount > 0 && (
                            <span className="font-semibold text-red-700">
                              {" "}
                              · {r.aiErrorCount} err
                            </span>
                          )}
                          <span className="block text-slate-500">
                            {tokens.toLocaleString("en-IN")} tok
                          </span>
                        </>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </TD>
                    <TD className="px-3 text-right">
                      <div className="flex flex-col items-end gap-1">
                        {canRun && canRetryRun(r.status) && (
                          <form action={retryQualificationRun}>
                            <input type="hidden" name="id" value={r.id} />
                            <Button type="submit" variant="secondary" className="h-8">
                              Retry
                            </Button>
                          </form>
                        )}
                        {canRun && isActiveRun(r.status) && (
                          <form action={cancelQualificationRun}>
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

      {canCrm && (
        <Card className="mb-6">
          <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Promote to CRM</CardTitle>
              <CardDescription>
                Creates a CRM lead for each qualified business in the chosen tiers that is not
                already a lead. Disqualified and do-not-contact businesses are never promoted;
                running it twice adds nothing new.
              </CardDescription>
            </div>
            <Link href="/crm" className="text-sm font-semibold text-brand-700">
              Open CRM →
            </Link>
          </CardHeader>
          <CardContent>
            <form
              action={promoteLeadsAction}
              className="flex flex-wrap items-end gap-4"
              aria-label="Promote to CRM"
            >
              <input type="hidden" name="scope" value="all" />
              <input type="hidden" name="returnTo" value="/leads" />
              <fieldset className="flex items-center gap-4">
                <legend className="mb-1.5 text-[13px] font-medium text-slate-700">Tiers</legend>
                {(["hot", "warm", "cold"] as const).map((t) => (
                  <label key={t} className="flex items-center gap-1.5 text-sm text-slate-800">
                    <input
                      type="checkbox"
                      name="tiers"
                      value={t}
                      defaultChecked={t !== "cold"}
                      className="h-4 w-4 rounded border-slate-300"
                    />
                    {tierLabel(t)}
                  </label>
                ))}
              </fieldset>
              <div className="flex w-52 flex-col gap-1.5">
                <Label htmlFor="assign">Assign</Label>
                <Select id="assign" name="assign" defaultValue="none">
                  <option value="none">Leave unassigned</option>
                  <option value="round_robin">Round-robin to operators</option>
                </Select>
              </div>
              <div className="flex w-32 flex-col gap-1.5">
                <Label htmlFor="promote-limit">Max new leads</Label>
                <Input
                  id="promote-limit"
                  name="limit"
                  type="number"
                  min={1}
                  max={1000}
                  step={1}
                  defaultValue={200}
                />
              </div>
              <Button type="submit">Promote to CRM</Button>
            </form>
          </CardContent>
        </Card>
      )}

      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Ranked leads</h2>
          <p className="text-xs text-slate-500">
            Latest rules score per business. All time:{" "}
            {TIERS.map((t, i) => (
              <span key={t}>
                {i > 0 && " · "}
                {tierLabel(t)} {tierTotal(t)}
              </span>
            ))}
          </p>
        </div>
        <form className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="f-tier">Tier</Label>
            <Select
              id="f-tier"
              name="tier"
              defaultValue={filters.tier === "qualified" ? "" : filters.tier || "all"}
              className="w-44"
            >
              <option value="">Hot, warm and cold</option>
              <option value="all">All, incl. disqualified</option>
              {TIERS.map((t) => (
                <option key={t} value={t}>
                  {tierLabel(t)}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="f-category">Category</Label>
            <Select
              id="f-category"
              name="category"
              defaultValue={filters.category}
              className="w-48"
            >
              <option value="">All</option>
              {KALPIX_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {categoryLabel(c)}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" variant="secondary">
            Apply
          </Button>
          <Link href="/leads" className="self-center text-sm font-semibold text-slate-500">
            Reset
          </Link>
        </form>
      </div>

      {anyMockLead && (
        <p
          role="note"
          className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-900"
        >
          Some leads are MOCK test data. They are not real businesses.
        </p>
      )}

      {leads.length === 0 ? (
        <EmptyState
          icon="Target"
          title="No qualified leads match"
          body="Businesses appear here after a qualification run scores them. Adjust the filters or start a run."
        />
      ) : (
        <Card>
          <Table>
            <THead>
              <tr>
                <TH className="w-12 px-3 text-right">#</TH>
                <TH className="px-3">Business</TH>
                <TH className="px-2 text-right">Score</TH>
                <TH className="px-3">Tier</TH>
                <TH className="px-3">Top reason</TH>
                <TH className="px-3">Category</TH>
                <TH className="px-3">Contactability</TH>
                <TH className="px-3">Qualified (IST)</TH>
                {canCrmRead && <TH className="px-3 text-right">CRM</TH>}
              </tr>
            </THead>
            <TBody>
              {leads.map((l, i) => {
                const q = l.qualifications[0];
                const reasons = parseReasons(q?.reasons);
                const top = topReason(reasons, l.latestTier);
                const channels = contactChannels(reasons);
                const mock = q?.isMock || l.source === "mock";
                return (
                  <tr key={l.id}>
                    <TD className="px-3 text-right text-xs tabular-nums text-slate-500">
                      {(page - 1) * LEADS_PAGE_SIZE + i + 1}
                    </TD>
                    <TD className="max-w-[14rem] px-3">
                      <Link
                        href={`/businesses/${l.id}#qualification`}
                        className="font-medium text-slate-900 hover:text-brand-700"
                      >
                        {l.name}
                      </Link>
                      {mock && (
                        <Badge tone="amber" className="ml-2">
                          MOCK
                        </Badge>
                      )}
                      <span className="block truncate text-xs text-slate-500">
                        {[l.locality, l.city].filter(Boolean).join(", ") || "—"}
                      </span>
                    </TD>
                    <TD className="px-2 text-right text-base font-semibold tabular-nums text-slate-900">
                      {l.latestScore ?? "—"}
                    </TD>
                    <TD className="px-3">
                      <Badge tone={TIER_TONE[l.latestTier ?? ""] ?? "neutral"}>
                        {tierLabel(l.latestTier)}
                      </Badge>
                    </TD>
                    <TD className="max-w-[20rem] px-3 text-xs text-slate-700">
                      {top ? (
                        <span className="line-clamp-2" title={top.text}>
                          {top.text}
                        </span>
                      ) : (
                        "—"
                      )}
                    </TD>
                    <TD className="px-3 text-xs">{categoryLabel(l.category)}</TD>
                    <TD className="px-3">
                      {channels.length ? (
                        <span className="flex flex-wrap gap-1">
                          {channels.map((c) => (
                            <Badge
                              key={c.channel}
                              tone={c.verified ? "green" : "neutral"}
                              title={c.verified ? "Verified" : "Found, not verified"}
                            >
                              {CHANNEL_LABEL[c.channel]}
                              {c.verified ? " ✓" : ""}
                            </Badge>
                          ))}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400">None usable</span>
                      )}
                    </TD>
                    <TD className="whitespace-nowrap px-3 text-xs text-slate-600">
                      {l.qualifiedAt ? formatDateTime(l.qualifiedAt) : "—"}
                    </TD>
                    {canCrmRead && (
                      <TD className="whitespace-nowrap px-3 text-right">
                        {l.lead ? (
                          <Link
                            href={`/crm/leads/${l.lead.id}`}
                            className="text-xs font-semibold text-brand-700"
                          >
                            In CRM →
                          </Link>
                        ) : canCrm &&
                          l.latestTier !== "disqualified" &&
                          l.contactStatus === "ok" ? (
                          <form action={createManualLeadAction}>
                            <input type="hidden" name="businessId" value={l.id} />
                            <input type="hidden" name="returnTo" value="/leads" />
                            <Button
                              type="submit"
                              variant="secondary"
                              className="h-7 px-2.5 text-xs"
                            >
                              Add to CRM
                            </Button>
                          </form>
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                      </TD>
                    )}
                  </tr>
                );
              })}
            </TBody>
          </Table>
        </Card>
      )}

      <div className="mt-4 flex items-center justify-between text-sm text-slate-500">
        <span>
          {leadTotal === 0 ? "0 leads" : `${from}–${to} of ${leadTotal} leads`} · sorted by score
        </span>
        <div className="flex gap-3">
          {page > 1 && (
            <Link
              className="font-semibold text-brand-700"
              href={`/leads${leadsQuery(filters, { page: String(page - 1) })}`}
            >
              Previous
            </Link>
          )}
          {page * LEADS_PAGE_SIZE < leadTotal && (
            <Link
              className="font-semibold text-brand-700"
              href={`/leads${leadsQuery(filters, { page: String(page + 1) })}`}
            >
              Next
            </Link>
          )}
        </div>
      </div>
    </>
  );
}
