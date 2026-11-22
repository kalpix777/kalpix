"use client";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

export function MfaSetup({ enabled }: { enabled: boolean }) {
  const [step, setStep] = useState<"idle" | "verify" | "done">("idle");
  const [totpURI, setTotpURI] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const secret = totpURI ? new URL(totpURI).searchParams.get("secret") : null;

  async function start(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const password = String(new FormData(e.currentTarget).get("password"));
    const res = enabled
      ? await authClient.twoFactor.disable({ password })
      : await authClient.twoFactor.enable({ password });
    setBusy(false);
    if (res.error) return setError(res.error.message ?? "Request failed");
    if (enabled) return window.location.reload();
    const data = res.data as { totpURI: string; backupCodes: string[] };
    setTotpURI(data.totpURI);
    setBackupCodes(data.backupCodes);
    setStep("verify");
  }

  async function verify(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const code = String(new FormData(e.currentTarget).get("code"));
    const res = await authClient.twoFactor.verifyTotp({ code });
    setBusy(false);
    if (res.error) return setError(res.error.message ?? "Invalid code");
    setStep("done");
  }

  if (step === "verify")
    return (
      <form onSubmit={verify} className="flex flex-col gap-4">
        <p className="text-sm text-slate-600">
          Add this key to your authenticator app (choose &quot;enter a setup key&quot;, time-based),
          then enter the 6-digit code it shows.
        </p>
        <code className="break-all rounded-md bg-slate-100 px-3 py-2 text-sm font-semibold tracking-wider">
          {secret}
        </code>
        <div className="flex max-w-xs flex-col gap-1.5">
          <Label htmlFor="code">Code</Label>
          <Input
            id="code"
            name="code"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            required
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        <div>
          <Button type="submit" disabled={busy}>
            Verify and turn on
          </Button>
        </div>
      </form>
    );

  if (step === "done")
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm font-semibold text-emerald-700">Two-factor authentication is on.</p>
        <p className="text-sm text-slate-600">
          Store these one-time backup codes somewhere safe. They are shown only once.
        </p>
        <ul className="grid grid-cols-2 gap-1.5 font-mono text-sm sm:grid-cols-5">
          {backupCodes.map((c) => (
            <li key={c} className="rounded bg-slate-100 px-2 py-1">
              {c}
            </li>
          ))}
        </ul>
        <div>
          <Button variant="secondary" onClick={() => (window.location.href = "/")}>
            Continue to dashboard
          </Button>
        </div>
      </div>
    );

  return (
    <form onSubmit={start} className="flex max-w-sm flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">Confirm your password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <div>
        <Button type="submit" variant={enabled ? "danger" : "primary"} disabled={busy}>
          {enabled ? "Turn off two-factor" : "Set up two-factor"}
        </Button>
      </div>
    </form>
  );
}
