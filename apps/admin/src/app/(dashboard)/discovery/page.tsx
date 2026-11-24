import Link from "next/link";
import { randomUUID } from "node:crypto";
import { KALPIX_CATEGORIES } from "@kalpix/core";
import { categoryLabel } from "@kalpix/providers";
import { db } from "@/lib/db";
import { can } from "@/lib/rbac";
import { formatDateTime } from "@/lib/utils";
import {
  canRetryRun,
  envValueForKind,
  isActiveRun,
  PROVIDER_OPTION_LABEL,
  providerLabel,
  RUN_STATUS_TONE,
} from "@/lib/discovery-display";
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
import { discoveryReadiness, selectableDiscoveryProviders } from "@/server/discovery";
import {
  cancelDiscoveryRun,
  retryDiscoveryRun,
  startDiscoveryRun,
} from "@/server/actions/discovery";

export const metadata = { title: "Business Discovery" };
export const dynamic = "force-dynamic";

export default async function DiscoveryPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const session = await requirePermission("dashboard:read");
  const { ok, error } = await searchParams;
  const canRun = can(session.user.role, "discovery:run");
  const [readiness, runs] = await Promise.all([
    discoveryReadiness(),
    db.discoveryRun.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  const anyActive = runs.some((r) => isActiveRun(r.status));
  const maxBbox = Number(process.env.DISCOVERY_MAX_BBOX_DEG2 || "0.25");
  const countryCodes = (process.env.NOMINATIM_COUNTRY_CODES || "in").trim();
  const defaultProvider = envValueForKind(readiness.kind);
  const providerOptions = selectableDiscoveryProviders();
  const isMock = readiness.kind === "mock";

  return (
    <>
      <PageHeader
        title="Business Discovery"
        description="Find businesses in an area by category. Runs are queued here and processed by the background worker (pnpm worker); results land in Businesses with their source."
        actions={<AutoRefresh active={anyActive} />}
      />
      <Flash ok={ok} error={error} />

      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Provider status</CardTitle>
            <CardDescription>Default for new runs, set by DISCOVERY_PROVIDER.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-slate-800">
                {readiness.providerId ? providerLabel(readiness.providerId) : "Not configured"}
              </span>
              {readiness.ready ? (
                <Badge tone="green">Ready</Badge>
              ) : (
                <Badge tone="red">Not ready</Badge>
              )}
            </div>
            {isMock && (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
                MOCK provider: every record is fake test data named “MOCK …”.
              </p>
            )}
            {readiness.kind === "osm" && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-600">Place-name geocoding (Nominatim)</span>
                {readiness.geocodeReady ? (
                  <Badge tone="green">Ready</Badge>
                ) : (
                  <Badge tone="amber">Bounding box only</Badge>
                )}
              </div>
            )}
            {readiness.problems.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-xs text-red-700">
                {readiness.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-500">
              <dt>Max box</dt>
              <dd className="text-right">{maxBbox} sq°</dd>
              <dt>Geocode countries</dt>
              <dd className="text-right uppercase">{countryCodes}</dd>
            </dl>
            {readiness.kind === "osm" && (
              <p className="text-xs text-slate-500">
                Data © OpenStreetMap contributors (ODbL). Attribution is kept on every record.
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Start a run</CardTitle>
            <CardDescription>
              Enter a place name (e.g. “Tilakwadi, Belagavi”) or a bounding box as
              south,west,north,east in decimal degrees.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {canRun ? (
              <form action={startDiscoveryRun} className="flex flex-col gap-4">
                <input type="hidden" name="idempotencyKey" value={randomUUID()} />
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="flex flex-col gap-1.5 sm:col-span-2">
                    <Label htmlFor="area">Area or bounding box</Label>
                    <Input
                      id="area"
                      name="area"
                      required
                      minLength={2}
                      maxLength={200}
                      placeholder="Tilakwadi, Belagavi  or  15.84,74.49,15.88,74.53"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="provider">Provider</Label>
                    <Select id="provider" name="provider" defaultValue={defaultProvider}>
                      {providerOptions.map((p) => (
                        <option key={p} value={p}>
                          {PROVIDER_OPTION_LABEL[p] ?? p}
                          {p === defaultProvider ? " (default)" : ""}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
                <fieldset>
                  <legend className="mb-2 text-[13px] font-medium text-slate-700">
                    Categories
                  </legend>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {KALPIX_CATEGORIES.map((c) => (
                      <label key={c} className="flex items-center gap-2 text-sm text-slate-700">
                        <input
                          type="checkbox"
                          name="categories"
                          value={c}
                          className="h-4 w-4 rounded border-slate-300"
                        />
                        {categoryLabel(c)}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div>
                  <Button type="submit">Queue run</Button>
                </div>
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
          icon="MapPinned"
          title="No discovery runs yet"
          body="Queued runs appear here with their status and counts."
        />
      ) : (
        <Card>
          <Table className="min-w-[56rem]">
            <THead>
              <tr>
                <TH>Queued (IST)</TH>
                <TH>Area</TH>
                <TH>Provider</TH>
                <TH>Status</TH>
                <TH className="px-2 text-right">Found</TH>
                <TH className="px-2 text-right">New</TH>
                <TH className="px-2 text-right">Upd.</TH>
                <TH className="px-2 text-right">Dupes</TH>
                <TH className="px-2 text-right">Skip</TH>
                <TH className="text-right">Actions</TH>
              </tr>
            </THead>
            <TBody>
              {runs.map((r) => {
                const mock = r.provider === "mock-discovery";
                return (
                  <tr key={r.id}>
                    <TD className="whitespace-nowrap text-xs">
                      {formatDateTime(r.createdAt)}
                      <span
                        className="block max-w-[10rem] truncate text-slate-400"
                        title={r.startedByLabel}
                      >
                        {r.startedByLabel}
                      </span>
                    </TD>
                    <TD>
                      <span className="block font-medium text-slate-900">
                        {r.areaDisplayName ?? r.area}
                      </span>
                      <span className="text-xs text-slate-500">
                        {r.categories.map((c) => categoryLabel(c)).join(", ")}
                      </span>
                      {r.error && (
                        <span className="mt-1 block max-w-xs text-xs text-red-700">{r.error}</span>
                      )}
                    </TD>
                    <TD className="text-xs">
                      {mock ? <Badge tone="amber">MOCK</Badge> : providerLabel(r.provider)}
                    </TD>
                    <TD>
                      <Badge tone={RUN_STATUS_TONE[r.status] ?? "neutral"}>{r.status}</Badge>
                      <span className="mt-1 block text-xs text-slate-500">
                        {r.completedCategories.length}/{r.categories.length} categories
                      </span>
                    </TD>
                    <TD className="px-2 text-right tabular-nums">{r.foundCount}</TD>
                    <TD className="px-2 text-right tabular-nums">{r.createdCount}</TD>
                    <TD className="px-2 text-right tabular-nums">{r.updatedCount}</TD>
                    <TD className="px-2 text-right tabular-nums">{r.duplicateCount}</TD>
                    <TD className="px-2 text-right tabular-nums">{r.skippedCount}</TD>
                    <TD className="text-right">
                      <div className="flex flex-col items-end gap-1">
                        <Link
                          href={`/businesses?run=${r.id}`}
                          className="inline-flex h-8 items-center px-2 text-sm font-semibold text-brand-700"
                        >
                          Results
                        </Link>
                        {canRun && canRetryRun(r.status) && (
                          <form action={retryDiscoveryRun}>
                            <input type="hidden" name="id" value={r.id} />
                            <Button type="submit" variant="secondary" className="h-8">
                              Retry
                            </Button>
                          </form>
                        )}
                        {canRun && isActiveRun(r.status) && (
                          <form action={cancelDiscoveryRun}>
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
