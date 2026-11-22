import Image from "next/image";
import { redirect } from "next/navigation";
import { getSession } from "@/server/session";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string }>;
}) {
  if (await getSession()) redirect("/");
  const { step } = await searchParams;
  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <Image src="/kalpix-mark.svg" alt="" width={40} height={40} priority />
          <span className="font-display text-2xl font-bold tracking-tight text-slate-900">
            kalpix
          </span>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="font-display text-lg font-semibold">
            {step === "2fa" ? "Two-factor verification" : "Sign in to the admin"}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {step === "2fa"
              ? "Enter the 6-digit code from your authenticator app."
              : "Accounts are created by an owner or administrator."}
          </p>
          <LoginForm step={step === "2fa" ? "2fa" : "password"} />
        </div>
      </div>
    </main>
  );
}
