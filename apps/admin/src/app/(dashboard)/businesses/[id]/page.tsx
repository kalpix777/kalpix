import Link from "next/link";
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
import { formatDateTime } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { requirePermission } from "@/server/session";

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

export default async function BusinessDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("dashboard:read");
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const b = await db.business.findUnique({ where: { id } });
  if (!b) notFound();
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
