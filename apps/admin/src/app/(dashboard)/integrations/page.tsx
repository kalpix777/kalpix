import { db } from "@/lib/db";
import { secretStatus } from "@/lib/provider-registry";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TBody, TD, TH, THead } from "@/components/ui/table";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Integrations" };
export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  await requirePermission("providers:manage");
  const providers = await db.providerConfig.findMany({
    orderBy: [{ category: "asc" }, { name: "asc" }],
  });
  return (
    <>
      <PageHeader
        title="Integrations"
        description="Connection readiness for every external service. A service shows Connected only after a real health check, which arrives with each adapter in its phase."
      />
      <Card>
        <Table>
          <THead>
            <tr>
              <TH>Service</TH>
              <TH>Category</TH>
              <TH>Tier</TH>
              <TH>Keys</TH>
              <TH>Health</TH>
              <TH>Status</TH>
            </tr>
          </THead>
          <TBody>
            {providers.map((p) => {
              const s = secretStatus(p.requiredSecrets);
              return (
                <tr key={p.id}>
                  <TD className="font-medium text-slate-900">{p.name}</TD>
                  <TD className="capitalize">{p.category}</TD>
                  <TD className="capitalize">{p.costTier}</TD>
                  <TD>
                    {p.requiredSecrets.length === 0 ? (
                      <Badge tone="green">Not needed</Badge>
                    ) : s.complete ? (
                      <Badge tone="green">Configured</Badge>
                    ) : (
                      <Badge tone="amber">{s.missing.length} missing</Badge>
                    )}
                  </TD>
                  <TD>
                    {p.lastHealthStatus ? (
                      <Badge tone={p.lastHealthStatus === "connected" ? "green" : "red"}>
                        {p.lastHealthStatus}
                      </Badge>
                    ) : (
                      <span className="text-xs text-slate-400">Not checked (adapter pending)</span>
                    )}
                  </TD>
                  <TD>
                    {p.enabled ? <Badge tone="green">Enabled</Badge> : <Badge>Disabled</Badge>}
                  </TD>
                </tr>
              );
            })}
          </TBody>
        </Table>
      </Card>
    </>
  );
}
