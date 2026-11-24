import Link from "next/link";
import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
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
import { formatDateTime } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Flash } from "@/components/flash";
import { Table, TBody, TD, TH, THead } from "@/components/ui/table";
import { requirePermission } from "@/server/session";
import { startResearchRun } from "@/server/actions/research";

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

const VERIFICATION_TONE: Record<string, "green" | "amber" | "neutral"> = {
  verified: "green",
  conflicting: "amber",
  unverified: "neutral",
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
  const [latest, facts, activeResearch] = await Promise.all([
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
  ]);
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

      <Card className="mt-6">
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
              <Table className="min-w-[52rem]">
                <THead>
                  <tr>
                    <TH className="w-40">Field</TH>
                    <TH>Value</TH>
                    <TH>Source</TH>
                    <TH className="px-2 text-right">Conf.</TH>
                    <TH className="px-3">Status</TH>
                    <TH className="px-3">Collected (IST)</TH>
                  </tr>
                </THead>
                <TBody>
                  {factGroups.map((g) =>
                    g.facts.map((f, i) => {
                      const src = safeHttpUrl(f.sourceUrl);
                      const conflicting = f.verificationStatus === "conflicting";
                      return (
                        <tr key={f.id} className={conflicting ? "bg-amber-50/70" : undefined}>
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
                          <TD className="px-3 align-top">
                            <Badge tone={VERIFICATION_TONE[f.verificationStatus] ?? "neutral"}>
                              {f.verificationStatus}
                            </Badge>
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
                “Conflicting” means sources disagree on this field; a person should check which
                value is current.
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
