"use client";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

export function LoginForm({ step }: { step: "password" | "2fa" }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    if (step === "password") {
      const { data, error } = await authClient.signIn.email({
        email: String(f.get("email")),
        password: String(f.get("password")),
      });
      if (error) setError(error.message ?? "Sign-in failed");
      else if (data && !("twoFactorRedirect" in data && data.twoFactorRedirect))
        window.location.href = "/";
    } else {
      const { error } = await authClient.twoFactor.verifyTotp({
        code: String(f.get("code")),
        trustDevice: false,
      });
      if (error) setError(error.message ?? "Invalid code");
      else window.location.href = "/";
    }
    setBusy(false);
  }

  return (
    <form onSubmit={onSubmit} className="mt-5 flex flex-col gap-4">
      {step === "password" ? (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              minLength={12}
            />
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="code">Authentication code</Label>
          <Input
            id="code"
            name="code"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            autoComplete="one-time-code"
            required
          />
        </div>
      )}
      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy}>
        {busy ? "Please wait…" : step === "password" ? "Sign in" : "Verify"}
      </Button>
    </form>
  );
}
