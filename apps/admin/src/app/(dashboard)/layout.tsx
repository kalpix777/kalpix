import Image from "next/image";
import { Menu } from "lucide-react";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { NAV } from "@/lib/navigation";
import { can, toRole } from "@/lib/rbac";
import { Sidebar } from "@/components/sidebar";
import { SignOutButton } from "@/components/sign-out";
import { Badge } from "@/components/ui/badge";
import { mfaRequired, requireUser } from "@/server/session";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await requireUser();
  const { user } = session;
  const allowed = NAV.filter((n) => !n.permission || can(user.role, n.permission)).map(
    (n) => n.slug,
  );
  const mfa = mfaRequired(user);
  const path = (await headers()).get("x-pathname") ?? "";
  if (mfa.missing && mfa.enforce && !path.startsWith("/security")) redirect("/security?required=1");
  const env = process.env.APP_ENV ?? "development";

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col overflow-y-auto border-r border-slate-200 bg-white lg:flex">
        <Link href="/" className="flex items-center gap-2.5 px-5 py-5">
          <Image src="/kalpix-mark.svg" alt="" width={30} height={30} />
          <span className="font-display text-lg font-bold tracking-tight">kalpix</span>
        </Link>
        <Sidebar allowed={allowed} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-4 border-b border-slate-200 bg-white/90 px-6 backdrop-blur">
          <div className="flex items-center gap-2">
            <details className="relative lg:hidden">
              <summary
                className="flex cursor-pointer list-none items-center gap-2 rounded-md px-1.5 py-1 hover:bg-slate-100"
                aria-label="Open menu"
              >
                <Image src="/kalpix-mark.svg" alt="" width={26} height={26} />
                <Menu className="h-5 w-5 text-slate-600" aria-hidden="true" />
              </summary>
              <div className="absolute left-0 top-11 z-20 max-h-[80vh] w-64 overflow-y-auto rounded-xl border border-slate-200 bg-white pt-3 shadow-lg">
                <Sidebar allowed={allowed} />
              </div>
            </details>
            <Badge tone={env === "production" ? "red" : "amber"}>{env.toUpperCase()}</Badge>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/security" className="text-right text-sm leading-tight hover:opacity-80">
              <span className="block font-semibold text-slate-800">{user.name}</span>
              <span className="block text-xs capitalize text-slate-500">
                {toRole(user.role)}
                {user.twoFactorEnabled ? " · MFA on" : ""}
              </span>
            </Link>
            <SignOutButton />
          </div>
        </header>
        {mfa.missing && (
          <div
            role="status"
            className="border-b border-amber-200 bg-amber-50 px-6 py-2.5 text-sm text-amber-900"
          >
            Administrators must enable two-factor authentication.{" "}
            <Link href="/security" className="font-semibold underline">
              Set it up now
            </Link>
            {mfa.enforce ? "." : " (enforced automatically in production)."}
          </div>
        )}
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
      </div>
    </div>
  );
}
