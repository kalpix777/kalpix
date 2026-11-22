import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { requireUser } from "@/server/session";
import { MfaSetup } from "./mfa-setup";

export const metadata = { title: "Account security" };

export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ required?: string }>;
}) {
  const { user } = await requireUser();
  const { required } = await searchParams;
  return (
    <>
      <PageHeader
        title="Account security"
        description="Two-factor authentication with any TOTP authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy)."
      />
      {required && (
        <p
          role="alert"
          className="mb-6 rounded-md border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900"
        >
          Your role requires two-factor authentication before you can use the dashboard.
        </p>
      )}
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Two-factor authentication{" "}
            {user.twoFactorEnabled ? (
              <Badge tone="green">On</Badge>
            ) : (
              <Badge tone="amber">Off</Badge>
            )}
          </CardTitle>
          <CardDescription>Signed in as {user.email}</CardDescription>
        </CardHeader>
        <CardContent>
          <MfaSetup enabled={Boolean(user.twoFactorEnabled)} />
        </CardContent>
      </Card>
    </>
  );
}
