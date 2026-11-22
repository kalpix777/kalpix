import { PageHeader } from "@/components/page-header";
import { Flash } from "@/components/flash";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { requirePermission } from "@/server/session";
import { getSettings } from "@/server/settings";
import { updateSettings } from "@/server/actions/settings";

export const metadata = { title: "System Settings" };
export const dynamic = "force-dynamic";

const approvalLabels = {
  outboundMessages: [
    "Customer-facing messages",
    "WhatsApp and email outreach wait for human approval.",
  ],
  financialActions: [
    "Financial actions",
    "Quotes, payment links, refunds and discounts need approval.",
  ],
  productionChanges: [
    "Production changes",
    "Customer website deployments and edits need approval.",
  ],
  paidProviderActivation: [
    "Paid provider activation",
    "Only the owner can switch on a paid or freemium service.",
  ],
} as const;

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  await requirePermission("settings:write");
  const { ok, error } = await searchParams;
  const s = await getSettings();
  return (
    <>
      <PageHeader
        title="System Settings"
        description="Agency profile and the human-approval rules every automated module must respect."
      />
      <Flash ok={ok} error={error} />
      <form action={updateSettings} className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Agency profile</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="agencyName">Agency name</Label>
              <Input id="agencyName" name="agencyName" defaultValue={s.agencyName} required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pilotMarket">Pilot market</Label>
              <Input id="pilotMarket" name="pilotMarket" defaultValue={s.pilotMarket} required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="defaultCurrency">Default currency</Label>
              <Select id="defaultCurrency" name="defaultCurrency" defaultValue={s.defaultCurrency}>
                {["INR", "USD", "EUR", "GBP", "AED"].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="timezone">Timezone</Label>
              <Input id="timezone" name="timezone" defaultValue={s.timezone} required />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Approval rules</CardTitle>
            <CardDescription>
              Only the owner can turn a rule off. Every change is written to the audit log.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {(Object.keys(approvalLabels) as (keyof typeof approvalLabels)[]).map((k) => (
              <label
                key={k}
                className="flex items-start gap-3 rounded-lg border border-slate-200 px-4 py-3"
              >
                <input
                  type="checkbox"
                  name={k}
                  defaultChecked={s.approvals[k]}
                  className="mt-1 h-4 w-4 accent-[#3730a3]"
                />
                <span>
                  <span className="block text-sm font-semibold">{approvalLabels[k][0]}</span>
                  <span className="text-sm text-slate-500">{approvalLabels[k][1]}</span>
                </span>
              </label>
            ))}
          </CardContent>
        </Card>
        <div>
          <Button type="submit">Save settings</Button>
        </div>
      </form>
    </>
  );
}
