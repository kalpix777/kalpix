import { db } from "@/lib/db";
import { formatMoney } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { Flash } from "@/components/flash";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead } from "@/components/ui/table";
import { requirePermission } from "@/server/session";
import { getSettings } from "@/server/settings";
import { createPackage, togglePackage } from "@/server/actions/packages";

export const metadata = { title: "Sales" };
export const dynamic = "force-dynamic";
const cycle = { one_time: "One-time", monthly: "Monthly", yearly: "Yearly" } as const;

export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  await requirePermission("pricing:manage");
  const { ok, error } = await searchParams;
  const [packages, settings] = await Promise.all([
    db.servicePackage.findMany({
      orderBy: [{ isDemo: "asc" }, { category: "asc" }, { name: "asc" }],
    }),
    getSettings(),
  ]);
  return (
    <>
      <PageHeader
        title="Sales · Service packages"
        description="Prices are configuration, not code. Quotations (Phase 13) are built only from active packages here."
      />
      <Flash ok={ok} error={error} />
      <Card className="mb-6">
        <Table>
          <THead>
            <tr>
              <TH>Package</TH>
              <TH>Category</TH>
              <TH>Billing</TH>
              <TH className="text-right">Price</TH>
              <TH className="text-right">Tax</TH>
              <TH>Status</TH>
              <TH />
            </tr>
          </THead>
          <TBody>
            {packages.map((p) => (
              <tr key={p.id}>
                <TD>
                  <span className="block font-medium text-slate-900">{p.name}</span>
                  <span className="text-xs text-slate-500">{p.code}</span>
                </TD>
                <TD className="capitalize">{p.category}</TD>
                <TD>{cycle[p.billingCycle]}</TD>
                <TD className="text-right tabular-nums">{formatMoney(p.priceMinor, p.currency)}</TD>
                <TD className="text-right tabular-nums">{p.taxRateBps / 100}%</TD>
                <TD>
                  {p.isDemo ? (
                    <Badge tone="amber">DEMO</Badge>
                  ) : p.active ? (
                    <Badge tone="green">Active</Badge>
                  ) : (
                    <Badge>Inactive</Badge>
                  )}
                </TD>
                <TD className="text-right">
                  {!p.isDemo && (
                    <form action={togglePackage}>
                      <input type="hidden" name="id" value={p.id} />
                      <input type="hidden" name="active" value={String(!p.active)} />
                      <Button type="submit" variant="ghost" className="h-8">
                        {p.active ? "Deactivate" : "Activate"}
                      </Button>
                    </form>
                  )}
                </TD>
              </tr>
            ))}
          </TBody>
        </Table>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>New package</CardTitle>
          <CardDescription>
            Enter prices including your margin; tax is applied separately on quotes and invoices.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={createPackage} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="code">Code</Label>
              <Input id="code" name="code" placeholder="WEB-STARTER" required />
            </div>
            <div className="flex flex-col gap-1.5 lg:col-span-3">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="category">Category</Label>
              <Select id="category" name="category">
                {[
                  "development",
                  "redesign",
                  "hosting",
                  "maintenance",
                  "seo",
                  "content",
                  "automation",
                  "support",
                ].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="billingCycle">Billing</Label>
              <Select id="billingCycle" name="billingCycle">
                {Object.entries(cycle).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="price">Price</Label>
              <Input id="price" name="price" type="number" min={0} step="0.01" required />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="currency">Currency</Label>
                <Select id="currency" name="currency" defaultValue={settings.defaultCurrency}>
                  {["INR", "USD", "EUR", "GBP", "AED"].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="taxRatePercent">Tax %</Label>
                <Input
                  id="taxRatePercent"
                  name="taxRatePercent"
                  type="number"
                  min={0}
                  max={50}
                  step="0.01"
                  defaultValue={18}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-4">
              <Label htmlFor="description">Description</Label>
              <Input id="description" name="description" />
            </div>
            <div>
              <Button type="submit">Create package</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </>
  );
}
