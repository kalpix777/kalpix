"use client";
import { LogOut } from "lucide-react";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  return (
    <button
      onClick={async () => {
        await authClient.signOut();
        window.location.href = "/login";
      }}
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100"
    >
      <LogOut className="h-4 w-4" aria-hidden="true" /> Sign out
    </button>
  );
}
