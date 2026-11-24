import type { BusinessDiscoveryProvider, GeocodingProvider } from "@kalpix/core";
import type { GeocodeCache } from "./cache";
import { GooglePlacesDiscoveryProvider } from "./google-places";
import type { FetchLike } from "./http";
import { MockDiscoveryProvider, MockGeocoder } from "./mock";
import { NominatimGeocoder } from "./osm/nominatim";
import { OverpassDiscoveryProvider } from "./osm/overpass";

export const DISCOVERY_PROVIDER_KINDS = ["osm", "mock", "google-places"] as const;
export type DiscoveryProviderKind = (typeof DISCOVERY_PROVIDER_KINDS)[number];

/** Provider descriptor id stored on DiscoveryRun.provider for each kind. */
export const DISCOVERY_PROVIDER_IDS: Record<DiscoveryProviderKind, string> = {
  osm: "osm-overpass",
  mock: "mock-discovery",
  "google-places": "google-places",
};

export function discoveryKindFromProviderId(id: string): DiscoveryProviderKind | null {
  const hit = Object.entries(DISCOVERY_PROVIDER_IDS).find(([, v]) => v === id);
  return hit ? (hit[0] as DiscoveryProviderKind) : null;
}

/** Values accepted in DISCOVERY_PROVIDER (documented in .env.example), with legacy aliases. */
export const DISCOVERY_PROVIDER_ENV_VALUES = ["overpass", "mock", "google_places"] as const;
const ENV_TO_KIND: Record<string, DiscoveryProviderKind> = {
  overpass: "osm",
  osm: "osm", // legacy alias
  mock: "mock",
  google_places: "google-places",
  "google-places": "google-places", // legacy alias
};

/** Maps a DISCOVERY_PROVIDER value (or a provider kind) to a kind; null when unknown. */
export function discoveryKindFromEnvValue(raw: string): DiscoveryProviderKind | null {
  return ENV_TO_KIND[raw.trim().toLowerCase()] ?? null;
}

export function resolveDiscoveryKind(
  env: Record<string, string | undefined>,
): DiscoveryProviderKind {
  const raw = (env.DISCOVERY_PROVIDER ?? "").trim() || "overpass";
  const kind = discoveryKindFromEnvValue(raw);
  if (!kind)
    throw new Error(
      `DISCOVERY_PROVIDER must be one of ${DISCOVERY_PROVIDER_ENV_VALUES.join(", ")} (got "${raw}")`,
    );
  if (kind === "mock" && env.APP_ENV === "production")
    throw new Error("DISCOVERY_PROVIDER=mock is not allowed in production");
  return kind;
}

export interface DiscoveryStack {
  kind: DiscoveryProviderKind;
  providerId: string;
  discovery: BusinessDiscoveryProvider & { requestsMade: number };
  geocoder: GeocodingProvider & { requestsMade: number };
}

export function createDiscoveryStack(
  kind: DiscoveryProviderKind,
  env: Record<string, string | undefined>,
  deps: { cache?: GeocodeCache; fetchImpl?: FetchLike; googleCommercialVerified?: boolean } = {},
): DiscoveryStack {
  const userAgent = `${env.APP_NAME || "Kalpix"}/0.1 (+${env.APP_URL || "http://localhost:3000"}; ${env.NOMINATIM_CONTACT_EMAIL || "contact not set"})`;
  const maxBbox = Number(env.DISCOVERY_MAX_BBOX_DEG2 || "0.25");
  const geocoder =
    kind === "mock"
      ? new MockGeocoder()
      : new NominatimGeocoder({
          baseUrl: env.NOMINATIM_BASE_URL,
          contactEmail: env.NOMINATIM_CONTACT_EMAIL?.trim() || undefined,
          appName: env.APP_NAME || "Kalpix",
          countryCodes: env.NOMINATIM_COUNTRY_CODES?.trim() || undefined,
          cache: deps.cache,
          fetchImpl: deps.fetchImpl,
        });
  if (kind === "mock")
    return {
      kind,
      providerId: DISCOVERY_PROVIDER_IDS.mock,
      discovery: new MockDiscoveryProvider(),
      geocoder,
    };
  if (kind === "google-places") {
    const g = Object.assign(
      new GooglePlacesDiscoveryProvider(env, deps.googleCommercialVerified ?? false),
      { requestsMade: 0 },
    );
    return { kind, providerId: DISCOVERY_PROVIDER_IDS["google-places"], discovery: g, geocoder };
  }
  return {
    kind,
    providerId: DISCOVERY_PROVIDER_IDS.osm,
    discovery: new OverpassDiscoveryProvider({
      endpoint: env.OVERPASS_API_URL,
      userAgent,
      maxBboxDeg2: Number.isFinite(maxBbox) && maxBbox > 0 ? maxBbox : 0.25,
      fetchImpl: deps.fetchImpl,
    }),
    geocoder,
  };
}
