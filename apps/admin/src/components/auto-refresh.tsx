"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-renders the current server page every `intervalMs` while `active` is true and the tab is
 * visible. Used for light polling of queued/running discovery runs.
 */
export function AutoRefresh({
  active,
  intervalMs = 5000,
}: {
  active: boolean;
  intervalMs?: number;
}) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [active, intervalMs, router]);
  if (!active) return null;
  return (
    <span className="text-xs text-slate-500" role="status">
      Auto-refreshing while runs are active
    </span>
  );
}
