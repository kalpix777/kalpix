import Link from "next/link";
import { KALPIX_CATEGORIES } from "@kalpix/core";
import { categoryLabel, OSM_ATTRIBUTION } from "@kalpix/providers";
import { db } from "@/lib/db";
import { can } from "@/lib/rbac";
import { businessWhere, filtersToQuery, parseBusinessFilters } from "@/lib/business-filters";
import {
  formatConfidence,
  isMockSource,
  isOsmSource,
  parsePage,
  providerLabel,
  safeHttpUrl,
} from "@/lib/discovery-display";
import {
  RESEARCH_STATUS_TONE,
  researchLinkForBusinessFilters,
  researchStatusLabel,
} from "@/lib/research-display";
import { formatDateTime } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead } from "@/components/ui/table";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Businesses" };
export const dynamic = "force-dynamic";
const PAGE = 50;

export default async function BusinessesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePermission("dashboard:read");
  const sp = await searchParams;
  const filters = parseBusinessFilters(sp);
  const p = parsePage(Array.isArray(sp.page) ? sp.page[0] : sp.page);
  const canExport = can(session.user.role, "businesses:export");
  const canResearch = can(session.user.role, "research:run");
  const researchLink = researchLinkForBusinessFilters(filters);
  const where = businessWhere(filters);
  const [rows, total, runs] = await Promise.all([
    db.business.findMany({
      where,
      orderBy: [{ lastSeenAt: "desc" }, { name: "asc" }],
      take: PAGE,
      skip: (p - 1) * PAGE,
      include: {
        researches: {
          orderBy: { researchedAt: "desc" },
          take: 1,
          select: { status: true, researchedAt: true },
        },
        _count: { select: { facts: { where: { verificationStatus: "conflicting" } } } },
      },
    }),
    db.business.count({ where }),
    db.discoveryRun.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, area: true, areaDisplayName: true, provider: true, createdAt: true },
    }),
  ]);
  const anyOsm = rows.some(isOsmSource);
  const anyMock = rows.some(isMockSource);
  const from = total === 0 ? 0 : (p - 1) * PAGE + 1;
  const to = Math.min(p * PAGE, total);

  return (
    <>
      <PageHeader
        title="Businesses"
        description="Every discovered business with its source, collection date and a completeness score. Confidence is a heuristic, not a verification."
        actions={
          canExport || canResearch ? (
            <div className="flex gap-2">
              {canResearch && (
                <Link
                  href={researchLink.href}
                  title={
                    researchLink.dropped.length
                      ? `Not carried over to research: ${researchLink.dropped.join(", ")}`
                      : "Open Business Research with these filters"
                  }
                  className="inline-flex h-9 items-center rounded-md border border-slate-300 bg-white px-3.5 text-sm font-semibold text-slate-800 hover:bg-slate-50"
                >
                  Research these
                </Link>
              )}
              {canExport && (
                <a
                  href={`/api/businesses/export${filtersToQuery(filters)}`}
                  className="inline-flex h-9 items-center rounded-md border border-slate-300 bg-white px-3.5 text-sm font-semibold text-slate-800 hover:bg-slate-50"
                >
                  Export CSV
                </a>
              )}
            </div>
          ) : undefined
        }
      />

      <form className="mb-4 grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-7">
        <div className="flex flex-col gap-1.5 lg:col-span-2">
          <Label htmlFor="q">Search</Label>
          <Input
            id="q"
            name="q"
            defaultValue={filters.q}
            maxLength={100}
            placeholder="Name, street, locality, phone or website"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="category">Category</Label>
          <Select id="category" name="category" defaultValue={filters.category}>
            <option value="">All</option>
            {KALPIX_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {categoryLabel(c)}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="run">Run</Label>
          <Select id="run" name="run" defaultValue={filters.run}>
            <option value="">All runs</option>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.provider === "mock-discovery" ? "[MOCK] " : ""}
                {(r.areaDisplayName ?? r.area).slice(0, 40)} · {formatDateTime(r.createdAt)}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="website">Website</Label>
          <Select id="website" name="website" defaultValue={filters.website}>
            <option value="">Any</option>
            <option value="yes">Has website</option>
            <option value="no">No website</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="phone">Phone</Label>
          <Select id="phone" name="phone" defaultValue={filters.phone}>
            <option value="">Any</option>
            <option value="yes">Has phone</option>
            <option value="no">No phone</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="research">Research</Label>
          <Select id="research" name="research" defaultValue={filters.research}>
            <option value="">Any</option>
            <option value="never">Never researched</option>
            <option value="researched">Researched</option>
            <option value="conflicts">Has conflicts</option>
          </Select>
        </div>
        <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-7">
          <Button type="submit" variant="secondary">
            Apply filters
          </Button>
          <Link href="/businesses" className="text-sm font-semibold text-slate-500">
            Reset
          </Link>
          {canResearch && researchLink.dropped.length > 0 && (
            <span className="ml-auto self-center text-xs text-slate-500">
              “Research these” can&apos;t carry over: {researchLink.dropped.join(", ")}
            </span>
          )}
        </div>
      </form>

      {anyMock && (
        <p
          role="note"
          className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-900"
        >
          Some rows are MOCK test data from the mock provider. They are not real businesses.
        </p>
      )}

      {rows.length === 0 ? (
        <EmptyState
          icon="Building2"
          title="No businesses match"
          body="Businesses appear after a discovery run completes. Adjust the filters or start a run in Business Discovery."
        />
      ) : (
        <Card>
          <Table>
            <THead>
              <tr>
                <TH>Name</TH>
                <TH>Category</TH>
                <TH>Location</TH>
                <TH>Phone</TH>
                <TH>Website</TH>
                <TH className="text-right">Confidence</TH>
                <TH>Research</TH>
                <TH>Source</TH>
              </tr>
            </THead>
            <TBody>
              {rows.map((b) => {
                const site = safeHttpUrl(b.website);
                const last = b.researches[0];
                const conflicts = b._count.facts;
                return (
                  <tr key={b.id}>
                    <TD>
                      <Link
                        href={`/businesses/${b.id}`}
                        className="font-medium text-slate-900 hover:text-brand-700"
                      >
                        {b.name}
                      </Link>
                      {isMockSource(b) && (
                        <Badge tone="amber" className="ml-2">
                          MOCK
                        </Badge>
                      )}
                    </TD>
                    <TD className="text-xs">{categoryLabel(b.category)}</TD>
                    <TD className="text-xs text-slate-600">
                      {[b.locality, b.city].filter(Boolean).join(", ") || "—"}
                    </TD>
                    <TD className="whitespace-nowrap text-xs">{b.phone ?? "—"}</TD>
                    <TD className="max-w-[12rem] truncate text-xs">
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
                        <span className="text-slate-400">None</span>
                      )}
                    </TD>
                    <TD className="text-right tabular-nums text-xs">
                      {formatConfidence(b.confidence)}
                    </TD>
                    <TD className="text-xs">
                      {last ? (
                        <span title={`Researched ${formatDateTime(last.researchedAt)} IST`}>
                          <Badge tone={RESEARCH_STATUS_TONE[last.status] ?? "neutral"}>
                            {researchStatusLabel(last.status)}
                          </Badge>
                        </span>
                      ) : (
                        <span className="text-slate-400">Never</span>
                      )}
                      {conflicts > 0 && (
                        <span className="mt-1 block font-semibold text-amber-800">
                          {conflicts} conflicting
                        </span>
                      )}
                    </TD>
                    <TD className="text-xs text-slate-500">
                      {isMockSource(b) ? "MOCK" : providerLabel(b.provider)}
                    </TD>
                  </tr>
                );
              })}
            </TBody>
          </Table>
        </Card>
      )}

      <div className="mt-4 flex items-center justify-between text-sm text-slate-500">
        <span>{total === 0 ? "0 businesses" : `${from}–${to} of ${total} businesses`}</span>
        <div className="flex gap-3">
          {p > 1 && (
            <Link
              className="font-semibold text-brand-700"
              href={`/businesses${filtersToQuery(filters, { page: String(p - 1) })}`}
            >
              Previous
            </Link>
          )}
          {p * PAGE < total && (
            <Link
              className="font-semibold text-brand-700"
              href={`/businesses${filtersToQuery(filters, { page: String(p + 1) })}`}
            >
              Next
            </Link>
          )}
        </div>
      </div>
      {anyOsm && <p className="mt-6 text-xs text-slate-500">{OSM_ATTRIBUTION}</p>}
    </>
  );
}
