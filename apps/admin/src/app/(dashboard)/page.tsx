import Link from "next/link";
import { db } from "@/lib/db";
import { NAV } from "@/lib/navigation";
import { formatDateTime } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/icon";
import { requireUser } from "@/server/session";
import { getSettings } from "@/server/settings";
import { PROVIDER_REGISTRY, secretStatus } from "@/lib/provider-registry";

export const dynamic = "force-dynamic";

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string }>;
}) {
  const session = await requireUser();
  const { denied } = await searchParams;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [users, enabledProviders, auditCount, packages, recent, settings] = await Promise.all([
    db.user.count(),
    db.providerConfig.count({ where: { enabled: true } }),
    db.auditLog.count({ where: { createdAt: { gte: since } } }),
    db.servicePackage.count({ where: { active: true, isDemo: false } }),
    db.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 6 }),
    getSettings(),
  ]);
  const keysConfigured = PROVIDER_REGISTRY.filter(
    (p) => p.requiredSecrets.length > 0 && secretStatus(p.requiredSecrets).complete,
  ).length;

  const stats = [
    { label: "Team members", value: users, hint: "with dashboard access" },
    {
      label: "Providers enabled",
      value: enabledProviders,
      hint: `${keysConfigured} have keys configured`,
    },
    { label: "Audit events (24h)", value: auditCount, hint: "sign-ins and changes" },
    { label: "Active packages", value: packages, hint: "excluding DEMO" },
  ];
  const pipeline = ["discovery", "research", "leads", "demos", "quotations", "payments"].map((s) =>
    NAV.find((n) => n.slug === s)!,
  );

  return (
    <>
      <PageHeader
        title={`Good to see you, ${session.user.name.split(" ")[0]}`}
        description={`${settings.agencyName} · pilot market ${settings.pilotMarket}`}
      />
      {denied && (
        <p
          role="alert"
          className="mb-6 rounded-md border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700"
        >
          You don&apos;t have permission to open that page.
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardContent className="py-5">
              <p className="text-[13px] font-medium text-slate-500">{s.label}</p>
              <p className="mt-1 font-display text-3xl font-semibold tabular-nums">{s.value}</p>
              <p className="mt-1 text-xs text-slate-400">{s.hint}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Acquisition pipeline</CardTitle>
            <CardDescription>
              Each stage unlocks as its phase is built and approved. No data is shown until it is
              real.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2">
            {pipeline.map((n) => (
              <Link
                key={n.slug}
                href={`/${n.slug}`}
                className="flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2.5 hover:border-brand-100 hover:bg-brand-50/40"
              >
                <Icon name={n.icon} className="h-4 w-4 text-brand-700" />
                <span className="text-sm font-medium">{n.label}</span>
                <Badge className="ml-auto">Phase {n.phase}</Badge>
              </Link>
            ))}
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
            <CardDescription>From the audit log</CardDescription>
          </CardHeader>
          <CardContent>
            {recent.length === 0 ? (
              <p className="text-sm text-slate-500">No activity yet.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {recent.map((r) => (
                  <li key={r.id} className="text-sm">
                    <span className="font-medium text-slate-800">{r.action}</span>
                    <span className="text-slate-500"> · {r.actorLabel}</span>
                    <span className="block text-xs text-slate-400">
                      {formatDateTime(r.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
