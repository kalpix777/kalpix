import Link from "next/link";
import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { MANUAL_OVERRIDE_STATUSES, parseQualificationConfig } from "@kalpix/core";
import { categoryLabel, OSM_ATTRIBUTION } from "@kalpix/providers";
import { db } from "@/lib/db";
import {
  formatConfidence,
  isMockSource,
  isOsmSource,
  providerLabel,
  safeHttpUrl,
  UUID_RE,
} from "@/lib/discovery-display";
import { can } from "@/lib/rbac";
import {
  describeSignals,
  fieldLabel,
  groupFacts,
  RESEARCH_STATUS_TONE,
  researchProviderLabel,
  researchStatusLabel,
  sourceTypeLabel,
} from "@/lib/research-display";
import {
  AI_STATUS_TONE,
  aiProviderLabel,
  disqualifiedLabel,
  evidenceSummary,
  methodLabel,
  OPERATING_LABEL,
  OPERATING_TONE,
  parseAiRisks,
  parseComponents,
  parseReasons,
  TIER_TONE,
  tierLabel,
  VERIFICATION_TONE,
} from "@/lib/qualification-display";
import { formatDateTime } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Flash } from "@/components/flash";
import { Input, Label, Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead } from "@/components/ui/table";
import { requirePermission } from "@/server/session";
import { startResearchRun } from "@/server/actions/research";
import { clearOverride, overrideFact, startQualificationRun } from "@/server/actions/qualification";
import { createManualLeadAction } from "@/server/actions/crm";
import { STAGE_TONE, stageLabel } from "@/lib/crm-display";

export const metadata = { title: "Business" };
export const dynamic = "force-dynamic";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-3 py-2 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd className="col-span-2 break-words text-slate-900">{children ?? "—"}</dd>
    </div>
  );
}

function Bar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="w-36 shrink-0 text-slate-600">{label}</span>
      <span className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
        <span className="block h-full rounded-full bg-brand-600" style={{ width: `${pct}%` }} />
      </span>
      <span className="w-14 shrink-0 text-right tabular-nums text-slate-900">
        {value}/{max}
      </span>
    </div>
  );
}

const REASON_KIND_LABEL: Record<string, string> = {
  opportunity: "Website",
  contact: "Contact",
  category: "Category",
  disqualification: "Disqualified",
  note: "Note",
};

export default async function BusinessDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const session = await requirePermission("dashboard:read");
  const { id } = await params;
  const { ok, error } = await searchParams;
  if (!UUID_RE.test(id)) notFound();
  const b = await db.business.findUnique({ where: { id } });
  if (!b) notFound();
  const canResearch = can(session.user.role, "research:run");
  const canQualify = can(session.user.role, "qualification:run");
  const canVerify = can(session.user.role, "facts:verify");
  const canCrmRead = can(session.user.role, "crm:read");
  const canCrmWrite = can(session.user.role, "crm:write");
  const crmLead = canCrmRead
    ? await db.lead.findUnique({
        where: { businessId: id },
        select: {
          id: true,
          stage: true,
          assignee: { select: { name: true, email: true } },
        },
      })
    : null;
  const [latest, facts, activeResearch, qual, activeQualification, qualSetting] = await Promise.all(
    [
      db.businessResearch.findFirst({
        where: { businessId: id },
        orderBy: { researchedAt: "desc" },
      }),
      db.researchFact.findMany({
        where: { businessId: id },
        orderBy: [{ field: "asc" }, { collectedAt: "desc" }],
        take: 500,
      }),
      db.researchRun.findFirst({
        where: { status: { in: ["queued", "running"] }, businessIds: { has: id } },
        select: { id: true, status: true },
      }),
      db.businessQualification.findFirst({
        where: { businessId: id },
        orderBy: { qualifiedAt: "desc" },
        include: { run: { select: { id: true, aiProvider: true, startedByLabel: true } } },
      }),
      db.qualificationRun.findFirst({
        where: { status: { in: ["queued", "running"] }, businessIds: { has: id } },
        select: { id: true, status: true },
      }),
      db.systemSetting.findUnique({ where: { key: "qualification" } }),
    ],
  );
  let qualConfig;
  try {
    qualConfig = parseQualificationConfig(qualSetting?.value ?? {});
  } catch {
    qualConfig = parseQualificationConfig({});
  }
  const factById = new Map(facts.map((f) => [f.id, f]));
  const reasons = qual ? parseReasons(qual.reasons) : [];
  const components = qual ? parseComponents(qual.components) : null;
  const aiRisks = qual ? parseAiRisks(qual.aiRisks) : [];
  const operatingHints = (() => {
    const v = qual?.verification as { operatingHints?: unknown } | null | undefined;
    return Array.isArray(v?.operatingHints)
      ? (v.operatingHints as { detail?: unknown }[])
          .map((h) => (typeof h?.detail === "string" ? h.detail : null))
          .filter((x): x is string => !!x)
      : [];
  })();
  const factLink = (fid: string) => {
    const f = factById.get(fid);
    if (!f) return null;
    return (
      <a
        key={fid}
        href={`#fact-${fid}`}
        className="inline-flex max-w-[16rem] items-center gap-1 truncate rounded bg-slate-100 px-1.5 py-0.5 text-xs text-brand-700 hover:bg-brand-50"
        title={`${fieldLabel(f.field)}: ${f.value}`}
      >
        {fieldLabel(f.field)}: {f.value.slice(0, 40)}
      </a>
    );
  };
  const returnTo = `/businesses/${id}`;
  const factGroups = groupFacts(facts);
  const conflictFields = factGroups
    .filter((g) => g.facts.some((f) => f.verificationStatus === "conflicting"))
    .map((g) => fieldLabel(g.field));
  const signalLines = latest ? describeSignals(latest.signals) : [];
  const latestUrl = latest ? safeHttpUrl(latest.finalUrl ?? latest.requestedUrl) : null;
  const runIds = [...new Set([b.firstRunId, b.lastRunId].filter((x): x is string => !!x))];
  const runs = runIds.length
    ? await db.discoveryRun.findMany({
        where: { id: { in: runIds } },
        select: { id: true, area: true, areaDisplayName: true, createdAt: true },
      })
    : [];
  const runLabel = (rid: string | null) => {
    if (!rid) return "—";
    const r = runs.find((x) => x.id === rid);
    return (
      <Link href={`/businesses?run=${rid}`} className="text-brand-700 hover:underline">
        {r ? `${r.areaDisplayName ?? r.area} · ${formatDateTime(r.createdAt)}` : rid}
      </Link>
    );
  };
  const mock = isMockSource(b);
  const osm = isOsmSource(b);
  const site = safeHttpUrl(b.website);
  const sourceUrl = safeHttpUrl(b.sourceUrl);
  const address =
    b.addressFull ||
    [b.houseNumber, b.street, b.locality, b.city, b.district, b.state, b.postcode]
      .filter(Boolean)
      .join(", ");

  return (
    <>
      <Link href="/businesses" className="mb-3 inline-block text-sm font-semibold text-brand-700">
        ← All businesses
      </Link>
      <PageHeader
        title={b.name}
        description={`${categoryLabel(b.category)}${b.subcategory ? ` · ${b.subcategory}` : ""}`}
        actions={
          <div className="flex gap-2">
            {mock && <Badge tone="amber">MOCK</Badge>}
            {b.latestTier && (
              <Badge tone={TIER_TONE[b.latestTier] ?? "neutral"}>
                {tierLabel(b.latestTier)} · {b.latestScore ?? "—"}
              </Badge>
            )}
            <Badge tone="neutral">{b.status}</Badge>
            <Badge tone={b.verificationStatus === "verified" ? "green" : "amber"}>
              {b.verificationStatus}
            </Badge>
          </div>
        }
      />
      <Flash ok={ok} error={error} />
      {mock && (
        <p
          role="note"
          className="mb-6 rounded-md border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-900"
        >
          MOCK record from the test provider. This is not a real business.
        </p>
      )}

      {canCrmRead && (
        <Card className="mb-6" id="crm">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-semibold text-slate-900">CRM</span>
              {crmLead ? (
                <>
                  <Badge tone={STAGE_TONE[crmLead.stage]}>{stageLabel(crmLead.stage)}</Badge>
                  <span className="text-slate-500">
                    {crmLead.assignee
                      ? `Assigned to ${crmLead.assignee.name || crmLead.assignee.email}`
                      : "Unassigned"}
                  </span>
                </>
              ) : (
                <span className="text-slate-500">Not a lead yet.</span>
              )}
              {b.contactStatus !== "ok" && <Badge tone="red">Do not contact</Badge>}
            </div>
            {crmLead ? (
              <Link
                href={`/crm/leads/${crmLead.id}`}
                className="text-sm font-semibold text-brand-700"
              >
                Open lead in CRM →
              </Link>
            ) : canCrmWrite && b.latestTier !== "disqualified" && b.contactStatus === "ok" ? (
              <form action={createManualLeadAction}>
                <input type="hidden" name="businessId" value={b.id} />
                <input type="hidden" name="returnTo" value={returnTo} />
                <Button type="submit" variant="secondary" className="h-8">
                  Add to CRM
                </Button>
              </form>
            ) : b.latestTier === "disqualified" ? (
              <span className="text-xs text-slate-500">
                Disqualified businesses cannot be leads.
              </span>
            ) : null}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Contact and location</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y divide-slate-100">
              <Row label="Address">{address || null}</Row>
              <Row label="Coordinates">
                {b.lat.toFixed(6)}, {b.lon.toFixed(6)}
              </Row>
              <Row label="Phone">{b.phone}</Row>
              <Row label="Website">
                {site ? (
                  <a
                    href={site}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="text-brand-700 hover:underline"
                  >
                    {b.website}
                  </a>
                ) : (
                  b.website
                )}
              </Row>
              <Row label="Email">{b.email}</Row>
              <Row label="Opening hours">{b.openingHours}</Row>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Provenance</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y divide-slate-100">
              <Row label="Provider">{mock ? "MOCK (test data)" : providerLabel(b.provider)}</Row>
              <Row label="Provider ID">
                <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{b.providerId}</code>
              </Row>
              <Row label="Source">
                {b.source} <span className="text-slate-500">({b.sourceType})</span>
              </Row>
              <Row label="Source URL">
                {sourceUrl ? (
                  <a
                    href={sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="text-brand-700 hover:underline"
                  >
                    {b.sourceUrl}
                  </a>
                ) : (
                  b.sourceUrl
                )}
              </Row>
              <Row label="First found in run">{runLabel(b.firstRunId)}</Row>
              <Row label="Last seen in run">{runLabel(b.lastRunId)}</Row>
              <Row label="Fetched at (IST)">{formatDateTime(b.collectedAt)}</Row>
              <Row label="Last seen (IST)">{formatDateTime(b.lastSeenAt)}</Row>
              <Row label="Confidence">
                {formatConfidence(b.confidence)}{" "}
                <span className="text-xs text-slate-500">(completeness heuristic)</span>
              </Row>
              <Row label="License">{b.license}</Row>
              <Row label="Usage">{b.usageRestrictions}</Row>
              {b.alternateIds.length > 0 && (
                <Row label="Merged records">{b.alternateIds.join(", ")}</Row>
              )}
            </dl>
            {osm && (
              <p className="mt-4 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
                {OSM_ATTRIBUTION}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6 scroll-mt-20" id="qualification">
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Qualification</CardTitle>
            <p className="mt-1 text-sm text-slate-500">
              Rules-based score ({qual?.rulesVersion ?? "rules"}). Every reason links to the facts
              it rests on.
            </p>
          </div>
          {canQualify && (
            <form action={startQualificationRun}>
              <input type="hidden" name="idempotencyKey" value={randomUUID()} />
              <input type="hidden" name="scope" value="businesses" />
              <input type="hidden" name="businessIds" value={b.id} />
              <input type="hidden" name="ai" value="none" />
              <input type="hidden" name="returnTo" value={returnTo} />
              <Button type="submit" variant="secondary" disabled={!!activeQualification}>
                {activeQualification ? "Qualification queued" : "Qualify (rules only)"}
              </Button>
            </form>
          )}
        </CardHeader>
        <CardContent>
          {!qual || !components ? (
            <p className="text-sm text-slate-500">
              Not qualified yet.{" "}
              {activeQualification
                ? "A qualification run including this business is queued."
                : canQualify
                  ? "Use “Qualify” here or start a run in Leads."
                  : ""}
            </p>
          ) : (
            <div className="grid gap-6 lg:grid-cols-5">
              <div className="flex flex-col gap-4 lg:col-span-2">
                <div className="flex items-center gap-4">
                  <span className="text-4xl font-semibold tabular-nums text-slate-900">
                    {qual.score}
                  </span>
                  <div className="flex flex-col gap-1">
                    <Badge tone={TIER_TONE[qual.tier] ?? "neutral"} className="w-fit">
                      {tierLabel(qual.tier)}
                    </Badge>
                    <span className="text-xs text-slate-500">
                      of 100 · {formatDateTime(qual.qualifiedAt)} IST
                    </span>
                  </div>
                  {qual.isMock && <Badge tone="amber">MOCK</Badge>}
                </div>
                <div className="flex flex-col gap-2">
                  <Bar
                    label="Website opportunity"
                    value={components.website}
                    max={qualConfig.website.max}
                  />
                  <Bar
                    label="Contactability"
                    value={components.contact}
                    max={qualConfig.contact.max}
                  />
                  <Bar
                    label="Category fit"
                    value={components.category}
                    max={qualConfig.categoryMax}
                  />
                </div>
                <dl className="divide-y divide-slate-100">
                  {qual.disqualifiedReason && (
                    <Row label="Disqualified">
                      <span className="font-semibold text-red-700">
                        {disqualifiedLabel(qual.disqualifiedReason)}
                      </span>
                      {qual.duplicateOfId && (
                        <Link
                          href={`/businesses/${qual.duplicateOfId}`}
                          className="ml-2 text-brand-700 hover:underline"
                        >
                          Original record
                        </Link>
                      )}
                    </Row>
                  )}
                  <Row label="Operating status">
                    <Badge tone={OPERATING_TONE[qual.operatingStatus] ?? "neutral"}>
                      {OPERATING_LABEL[qual.operatingStatus] ?? qual.operatingStatus}
                    </Badge>
                    {operatingHints.length > 0 && (
                      <span className="mt-1 block text-xs text-slate-600">
                        {operatingHints.join("; ")}
                      </span>
                    )}
                  </Row>
                </dl>
              </div>
              <div className="lg:col-span-3">
                <h3 className="mb-2 text-sm font-semibold text-slate-800">Reasons</h3>
                <ul className="flex flex-col gap-2">
                  {reasons.map((r, i) => (
                    <li
                      key={`${r.code}-${i}`}
                      className="rounded-md border border-slate-200 px-3 py-2 text-sm"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <span className="text-slate-800">
                          <span className="mr-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                            {REASON_KIND_LABEL[r.kind] ?? r.kind}
                          </span>
                          {r.text}
                        </span>
                        <span
                          className={
                            r.points > 0
                              ? "shrink-0 font-semibold tabular-nums text-emerald-700"
                              : "shrink-0 tabular-nums text-slate-400"
                          }
                        >
                          {r.points > 0 ? `+${r.points}` : r.points}
                        </span>
                      </div>
                      {(r.factIds.length > 0 || r.researchId) && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {r.factIds.map(factLink)}
                          {r.researchId && (
                            <a
                              href="#research"
                              className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-brand-700 hover:bg-brand-50"
                            >
                              Website research
                            </a>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {qual && qual.aiStatus !== "off" && (
        <Card className="mt-6 border-dashed" id="ai-suggestion">
          <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>AI suggestion — not verified</CardTitle>
              <p className="mt-1 text-sm text-slate-500">
                Generated text to help a person prepare. It does not change the score or tier and
                may be wrong: check it against the facts before using it.
              </p>
            </div>
            <div className="flex gap-2">
              {qual.aiIsMock && <Badge tone="amber">MOCK</Badge>}
              <Badge tone={AI_STATUS_TONE[qual.aiStatus] ?? "neutral"}>{qual.aiStatus}</Badge>
            </div>
          </CardHeader>
          <CardContent className="grid gap-5 lg:grid-cols-3">
            <div className="flex flex-col gap-3 text-sm lg:col-span-2">
              {qual.aiIsMock && (
                <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
                  MOCK model output: fixture text for testing, not a model&apos;s judgement.
                </p>
              )}
              {qual.aiStatus === "skipped" && (
                <p className="text-slate-500">
                  AI was skipped for this business (disqualified businesses are not sent to AI).
                </p>
              )}
              {qual.aiStatus === "error" && (
                <p className="text-red-700">AI step failed: {qual.aiError ?? "unknown error"}</p>
              )}
              {qual.aiSummary && (
                <div>
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Summary
                  </h3>
                  <p className="text-slate-800">{qual.aiSummary}</p>
                </div>
              )}
              {qual.aiPitch && (
                <div>
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Pitch angle
                  </h3>
                  <p className="text-slate-800">{qual.aiPitch}</p>
                </div>
              )}
              {aiRisks.length > 0 && (
                <div>
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Risks
                  </h3>
                  <ul className="flex flex-col gap-1.5">
                    {aiRisks.map((r, i) => (
                      <li key={i} className="text-slate-800">
                        <span className="mr-1.5 text-xs text-slate-500">{r.code}</span>
                        {r.text}
                        {r.factIds.length > 0 && (
                          <span className="ml-1.5 inline-flex flex-wrap gap-1">
                            {r.factIds.map(factLink)}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {qual.aiError && qual.aiStatus === "ok" && (
                <p className="text-xs text-amber-800">{qual.aiError}</p>
              )}
            </div>
            <dl className="divide-y divide-slate-100 self-start">
              <Row label="Provider">{aiProviderLabel(qual.aiProvider ?? qual.run.aiProvider)}</Row>
              <Row label="Model">{qual.aiModel}</Row>
              <Row label="Prompt">{qual.aiPromptVersion}</Row>
              <Row label="Tokens">
                {qual.aiInputTokens != null
                  ? `${qual.aiInputTokens} in / ${qual.aiOutputTokens ?? 0} out`
                  : null}
              </Row>
            </dl>
          </CardContent>
        </Card>
      )}

      <Card className="mt-6 scroll-mt-20" id="research">
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Research</CardTitle>
            <p className="mt-1 text-sm text-slate-500">
              What Kalpix read on this business&apos;s website and listings. Observations and
              sourced facts only: nothing here is a score.
            </p>
          </div>
          {canResearch && (
            <form action={startResearchRun}>
              <input type="hidden" name="idempotencyKey" value={randomUUID()} />
              <input type="hidden" name="scope" value="businesses" />
              <input type="hidden" name="businessIds" value={b.id} />
              <input type="hidden" name="returnTo" value={`/businesses/${b.id}`} />
              <Button type="submit" variant="secondary" disabled={!!activeResearch}>
                {activeResearch ? "Research queued" : "Research this business"}
              </Button>
            </form>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {!latest ? (
            <p className="text-sm text-slate-500">
              Not researched yet.{" "}
              {activeResearch
                ? "A research run including this business is queued; it appears here when the worker finishes."
                : canResearch
                  ? "Use “Research this business” to read its website."
                  : ""}
            </p>
          ) : (
            <div className="grid gap-5 lg:grid-cols-2">
              <dl className="divide-y divide-slate-100">
                <Row label="Latest result">
                  <Badge tone={RESEARCH_STATUS_TONE[latest.status] ?? "neutral"}>
                    {researchStatusLabel(latest.status)}
                  </Badge>
                  {latest.provider === "mock-research" && (
                    <Badge tone="amber" className="ml-2">
                      MOCK
                    </Badge>
                  )}
                </Row>
                <Row label="Researched (IST)">{formatDateTime(latest.researchedAt)}</Row>
                <Row label="Provider">{researchProviderLabel(latest.provider)}</Row>
                <Row label="Website read">
                  {latestUrl ? (
                    <a
                      href={latestUrl}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="break-all text-brand-700 hover:underline"
                    >
                      {latest.finalUrl ?? latest.requestedUrl}
                    </a>
                  ) : (
                    (latest.finalUrl ?? latest.requestedUrl)
                  )}
                </Row>
                <Row label="Facts found">
                  {latest.factCount}
                  {latest.requestCount > 0 && (
                    <span className="text-xs text-slate-500">
                      {" "}
                      ({latest.requestCount} request{latest.requestCount === 1 ? "" : "s"})
                    </span>
                  )}
                </Row>
                {conflictFields.length > 0 && (
                  <Row label="Conflicts">
                    <span className="font-semibold text-amber-800">
                      {conflictFields.join(", ")}
                    </span>
                  </Row>
                )}
                {latest.error && (
                  <Row label="Error">
                    <span className="text-red-700">{latest.error}</span>
                  </Row>
                )}
              </dl>
              <div>
                <h3 className="mb-2 text-sm font-semibold text-slate-800">What we noticed</h3>
                {latest.summary && <p className="mb-2 text-sm text-slate-700">{latest.summary}</p>}
                {signalLines.length > 0 ? (
                  <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
                    {signalLines.map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                ) : (
                  !latest.summary && (
                    <p className="text-sm text-slate-500">No website observations recorded.</p>
                  )
                )}
              </div>
            </div>
          )}

          {factGroups.length > 0 && (
            <div className="-mx-5 border-t border-slate-100">
              <Table className="min-w-[60rem]">
                <THead>
                  <tr>
                    <TH className="w-40">Field</TH>
                    <TH>Value</TH>
                    <TH>Source</TH>
                    <TH className="px-2 text-right">Conf.</TH>
                    <TH className="px-3">Verification</TH>
                    <TH className="px-3">Collected (IST)</TH>
                  </tr>
                </THead>
                <TBody>
                  {factGroups.map((g) =>
                    g.facts.map((f, i) => {
                      const src = safeHttpUrl(f.sourceUrl);
                      const conflicting = f.verificationStatus === "conflicting";
                      return (
                        <tr
                          key={f.id}
                          id={`fact-${f.id}`}
                          className={`scroll-mt-20 target:bg-brand-50 ${
                            conflicting
                              ? "bg-amber-50/70"
                              : f.verificationStatus === "invalid"
                                ? "bg-red-50/60"
                                : ""
                          }`}
                        >
                          {i === 0 && (
                            <TD
                              rowSpan={g.facts.length}
                              className="align-top text-sm font-medium text-slate-900"
                            >
                              {fieldLabel(g.field)}
                            </TD>
                          )}
                          <TD className="max-w-[18rem] break-words align-top text-sm text-slate-900">
                            {f.value}
                            {f.provider === "mock-research" && (
                              <Badge tone="amber" className="ml-2">
                                MOCK
                              </Badge>
                            )}
                          </TD>
                          <TD className="max-w-[16rem] align-top text-xs">
                            <span className="block text-slate-600">
                              {sourceTypeLabel(f.sourceType)}
                            </span>
                            {src ? (
                              <a
                                href={src}
                                target="_blank"
                                rel="noopener noreferrer nofollow"
                                className="block truncate text-brand-700 hover:underline"
                                title={f.sourceUrl}
                              >
                                {f.sourceUrl}
                              </a>
                            ) : (
                              <span className="block truncate text-slate-500" title={f.sourceUrl}>
                                {f.sourceUrl}
                              </span>
                            )}
                          </TD>
                          <TD className="px-2 text-right align-top text-xs tabular-nums">
                            {formatConfidence(f.confidence)}
                          </TD>
                          <TD className="max-w-[17rem] px-3 align-top text-xs">
                            <span className="flex flex-wrap items-center gap-1">
                              <Badge tone={VERIFICATION_TONE[f.verificationStatus] ?? "neutral"}>
                                {f.verificationStatus}
                              </Badge>
                              {f.verificationOverride && (
                                <Badge
                                  tone="brand"
                                  title={`Set by ${f.verifiedByLabel ?? "?"}${
                                    f.verifiedAt ? ` on ${formatDateTime(f.verifiedAt)} IST` : ""
                                  }: ${f.overrideReason ?? ""}`}
                                >
                                  Override
                                </Badge>
                              )}
                            </span>
                            {f.verificationOverride ? (
                              <span className="mt-1 block text-slate-600">
                                By {f.verifiedByLabel ?? "?"}
                                {f.verifiedAt ? ` · ${formatDateTime(f.verifiedAt)}` : ""}
                                <span className="block break-words italic text-slate-500">
                                  “{f.overrideReason}”
                                </span>
                              </span>
                            ) : (
                              <span className="mt-1 block text-slate-500">
                                {methodLabel(f.verificationMethod)}
                                {evidenceSummary(f.verificationEvidence) && (
                                  <span className="block break-words text-slate-500">
                                    {evidenceSummary(f.verificationEvidence)}
                                  </span>
                                )}
                              </span>
                            )}
                            {canVerify && (
                              <details className="mt-1">
                                <summary className="cursor-pointer font-semibold text-brand-700">
                                  {f.verificationOverride ? "Change override" : "Override"}
                                </summary>
                                <form action={overrideFact} className="mt-2 flex flex-col gap-1.5">
                                  <input type="hidden" name="factId" value={f.id} />
                                  <input type="hidden" name="returnTo" value={returnTo} />
                                  <Label htmlFor={`st-${f.id}`} className="text-xs">
                                    Status
                                  </Label>
                                  <Select
                                    id={`st-${f.id}`}
                                    name="status"
                                    defaultValue={f.verificationStatus}
                                    className="h-8 text-xs"
                                  >
                                    {MANUAL_OVERRIDE_STATUSES.map((st) => (
                                      <option key={st} value={st}>
                                        {st}
                                      </option>
                                    ))}
                                  </Select>
                                  <Label htmlFor={`rs-${f.id}`} className="text-xs">
                                    Reason (required)
                                  </Label>
                                  <Input
                                    id={`rs-${f.id}`}
                                    name="reason"
                                    required
                                    minLength={3}
                                    maxLength={500}
                                    placeholder="e.g. Called the number, owner answered"
                                    className="h-8 text-xs"
                                  />
                                  <Button type="submit" variant="secondary" className="h-8 w-fit">
                                    Save override
                                  </Button>
                                </form>
                                {f.verificationOverride && (
                                  <form action={clearOverride} className="mt-1.5">
                                    <input type="hidden" name="factId" value={f.id} />
                                    <input type="hidden" name="returnTo" value={returnTo} />
                                    <Button type="submit" variant="ghost" className="h-8 px-0">
                                      Remove override
                                    </Button>
                                  </form>
                                )}
                              </details>
                            )}
                          </TD>
                          <TD className="whitespace-nowrap px-3 align-top text-xs text-slate-600">
                            {formatDateTime(f.collectedAt)}
                          </TD>
                        </tr>
                      );
                    }),
                  )}
                </TBody>
              </Table>
              <p className="px-5 pt-3 text-xs text-slate-500">
                Confidence reflects how reliable the extraction method is, not a verification.
                Verification is set by the automatic checks in each qualification run (format,
                independent sources, mail domain, website reachability) or by a person&apos;s
                override, which the automatic checks never change. “Conflicting” means sources
                disagree; “invalid” values are ignored by the score. Overrides affect the score on
                the next qualification run.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {b.rawTags && (
        <Card className="mt-6">
          <CardContent className="pt-5">
            <details>
              <summary className="cursor-pointer text-sm font-semibold text-slate-700">
                Raw provider tags
              </summary>
              <pre className="mt-3 max-h-96 overflow-auto rounded-md bg-slate-50 p-3 text-xs text-slate-700">
                {JSON.stringify(b.rawTags, null, 2)}
              </pre>
            </details>
          </CardContent>
        </Card>
      )}
    </>
  );
}
