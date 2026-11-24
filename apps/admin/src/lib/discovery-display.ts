/** Display helpers shared by the discovery and businesses pages (pure, unit-tested). */

export type Tone = "neutral" | "green" | "amber" | "red" | "brand";

export const RUN_STATUS_TONE: Record<string, Tone> = {
  queued: "neutral",
  running: "brand",
  succeeded: "green",
  failed: "red",
  cancelled: "amber",
};

export const ACTIVE_RUN_STATUSES = ["queued", "running"] as const;
export const isActiveRun = (status: string) =>
  (ACTIVE_RUN_STATUSES as readonly string[]).includes(status);
export const canRetryRun = (status: string) => status === "failed" || status === "cancelled";

/** Human labels for DiscoveryRun.provider / Business.provider descriptor ids. */
export function providerLabel(providerId: string): string {
  switch (providerId) {
    case "osm-overpass":
      return "OpenStreetMap (Overpass)";
    case "mock-discovery":
      return "MOCK (test data)";
    case "google-places":
      return "Google Places";
    default:
      return providerId;
  }
}

/** Labels for DISCOVERY_PROVIDER values on the start-run form. */
export const PROVIDER_OPTION_LABEL: Record<string, string> = {
  overpass: "OpenStreetMap (Overpass)",
  mock: "MOCK (test data only)",
  google_places: "Google Places (not built yet)",
};

/** Maps an internal provider kind back to its DISCOVERY_PROVIDER value. */
export function envValueForKind(kind: string | null): string {
  if (kind === "osm") return "overpass";
  if (kind === "google-places") return "google_places";
  return kind ?? "overpass";
}

export const isMockSource = (b: { source?: string | null; provider?: string | null }) =>
  b.source === "mock" || b.provider === "mock-discovery";

export const isOsmSource = (b: { source?: string | null }) => b.source === "openstreetmap";

/** Only http(s) links from provider data are rendered as anchors (blocks javascript: etc). */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(candidate);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export const formatConfidence = (c: number) => `${Math.round(Math.max(0, Math.min(1, c)) * 100)}%`;

export function parsePage(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 100_000 ? n : 1;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
