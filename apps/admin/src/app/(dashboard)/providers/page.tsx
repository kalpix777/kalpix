import { db } from "@/lib/db";
import { secretStatus } from "@/lib/provider-registry";
import { formatMoney } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { Flash } from "@/components/flash";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { requirePermission } from "@/server/session";
import {
  setCommercialVerified,
  toggleProvider,
  updateProviderLimits,
} from "@/server/actions/providers";

export const metadata = { title: "AI Provider Settings" };
export const dynamic = "force-dynamic";

const tierTone = { free: "green", freemium: "amber", paid: "red" } as const;

export default async function ProvidersPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string; category?: string }>;
}) {
  const session = await requirePermission("providers:manage");
  const { ok, error } = await searchParams;
  const providers = await db.providerConfig.findMany({
    orderBy: [{ category: "asc" }, { costTier: "asc" }, { name: "asc" }],
  });
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const usage = await db.usageEvent.groupBy({
    by: ["providerId"],
    where: { createdAt: { gte: monthStart } },
    _sum: { units: true, costMinor: true },
  });
  const usageBy = new Map(usage.map((u) => [u.providerId, u._sum]));
  const isOwner = session.user.role === "owner";
  const categories = [...new Set(providers.map((p) => p.category))];

  return (
    <>
      <PageHeader
        title="AI Provider Settings"
        description="Every external provider sits behind an adapter. Keys live in server environment variables only; this screen shows whether they are set, never their values."
      />
      <Flash ok={ok} error={error} />
      <div className="flex flex-col gap-6">
        {categories.map((cat) => (
          <Card key={cat}>
            <CardHeader>
              <CardTitle className="capitalize">{cat}</CardTitle>
              <CardDescription>
                A provider can be enabled only when its keys are set and its commercial-use terms
                are confirmed by the owner.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col divide-y divide-slate-100 p-0">
              {providers
                .filter((p) => p.category === cat)
                .map((p) => {
                  const s = secretStatus(p.requiredSecrets);
                  const u = usageBy.get(p.id);
                  return (
                    <div key={p.id} className="grid gap-4 px-5 py-4 lg:grid-cols-[1.4fr_1fr_1.3fr]">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold">{p.name}</span>
                          <Badge tone={tierTone[p.costTier]}>{p.costTier}</Badge>
                          <Badge tone={p.enabled ? "green" : "neutral"}>
                            {p.enabled ? "Enabled" : "Disabled"}
                          </Badge>
                        </div>
                        <p className="mt-1 text-xs text-slate-500">{p.notes}</p>
                        <p className="mt-2 text-xs text-slate-600">
                          Keys:{" "}
                          {p.requiredSecrets.length === 0 ? (
                            <span className="text-emerald-700">none required</span>
                          ) : (
                            p.requiredSecrets.map((k) => (
                              <code
                                key={k}
                                className={`mr-1.5 rounded px-1 py-0.5 text-[11px] ${s.configured.includes(k) ? "bg-emerald-50 text-emerald-800" : "bg-slate-100 text-slate-500"}`}
                              >
                                {k} {s.configured.includes(k) ? "✓" : "missing"}
                              </code>
                            ))
                          )}
                        </p>
                      </div>
                      <div className="text-xs text-slate-600">
                        <p>
                          Usage this month:{" "}
                          <span className="font-semibold tabular-nums">{u?.units ?? 0}</span> units
                        </p>
                        <p>
                          Cost this month:{" "}
                          <span className="font-semibold tabular-nums">
                            {formatMoney(u?.costMinor ?? 0, p.currency)}
                          </span>
                        </p>
                        <p>
                          Limit: {p.monthlyLimitUnits ?? "none"} · Budget:{" "}
                          {p.monthlyBudgetMinor != null
                            ? formatMoney(p.monthlyBudgetMinor, p.currency)
                            : "none"}
                        </p>
                        <p>Fallback: {p.fallbackProviderId ?? "none"}</p>
                        <p>
                          Commercial terms:{" "}
                          <span
                            className={
                              p.commercialUseVerified ? "text-emerald-700" : "text-amber-700"
                            }
                          >
                            {p.commercialUseVerified ? "verified" : "not verified"}
                          </span>
                        </p>
                      </div>
                      <div className="flex flex-col gap-2">
                        <div className="flex flex-wrap gap-2">
                          <form action={toggleProvider}>
                            <input type="hidden" name="id" value={p.id} />
                            <input type="hidden" name="enable" value={String(!p.enabled)} />
                            <Button variant={p.enabled ? "secondary" : "primary"} type="submit">
                              {p.enabled ? "Disable" : "Enable"}
                            </Button>
                          </form>
                          {isOwner && (
                            <form action={setCommercialVerified}>
                              <input type="hidden" name="id" value={p.id} />
                              <input
                                type="hidden"
                                name="verified"
                                value={String(!p.commercialUseVerified)}
                              />
                              <Button variant="ghost" type="submit">
                                {p.commercialUseVerified ? "Unverify terms" : "Confirm terms"}
                              </Button>
                            </form>
                          )}
                        </div>
                        <details className="text-sm">
                          <summary className="cursor-pointer text-xs font-semibold text-brand-700">
                            Limits and fallback
                          </summary>
                          <form
                            action={updateProviderLimits}
                            className="mt-2 grid grid-cols-2 gap-2"
                          >
                            <input type="hidden" name="id" value={p.id} />
                            <div>
                              <Label htmlFor={`l-${p.id}`}>Monthly units</Label>
                              <Input
                                id={`l-${p.id}`}
                                name="monthlyLimitUnits"
                                type="number"
                                min={0}
                                defaultValue={p.monthlyLimitUnits ?? ""}
                              />
                            </div>
                            <div>
                              <Label htmlFor={`b-${p.id}`}>Budget ({p.currency})</Label>
                              <Input
                                id={`b-${p.id}`}
                                name="monthlyBudget"
                                type="number"
                                min={0}
                                step="0.01"
                                defaultValue={
                                  p.monthlyBudgetMinor != null ? p.monthlyBudgetMinor / 100 : ""
                                }
                              />
                            </div>
                            <div className="col-span-2">
                              <Label htmlFor={`f-${p.id}`}>Fallback</Label>
                              <Select
                                id={`f-${p.id}`}
                                name="fallbackProviderId"
                                defaultValue={p.fallbackProviderId ?? ""}
                              >
                                <option value="">None</option>
                                {providers
                                  .filter((o) => o.category === p.category && o.id !== p.id)
                                  .map((o) => (
                                    <option key={o.id} value={o.id}>
                                      {o.name}
                                    </option>
                                  ))}
                              </Select>
                            </div>
                            <Button type="submit" variant="secondary" className="col-span-2">
                              Save
                            </Button>
                          </form>
                        </details>
                      </div>
                    </div>
                  );
                })}
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
