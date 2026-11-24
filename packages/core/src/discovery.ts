/**
 * Business discovery contract (Phase 3). Adapters live in @kalpix/providers; the job runner in
 * apps/worker. Everything an adapter returns is normalised into BusinessCandidate, carrying the
 * provenance fields required by docs/ARCHITECTURE.md "Data provenance".
 */
import type { Provider, Result } from "./provider";

/** Kalpix industries. Their mapping to provider tags lives in config, not code. */
export const KALPIX_CATEGORIES = [
  "restaurants",
  "hotels",
  "hospitals",
  "clinics",
  "manufacturers",
  "retail",
  "supermarkets",
  "education",
  "real_estate",
  "automobile",
  "garages",
  "professional_services",
] as const;
export type KalpixCategory = (typeof KALPIX_CATEGORIES)[number];

export function isKalpixCategory(v: string): v is KalpixCategory {
  return (KALPIX_CATEGORIES as readonly string[]).includes(v);
}

/** Bounding box in WGS84 degrees. */
export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface ResolvedArea {
  query: string;
  displayName: string;
  bbox: BBox;
  source: string; // "nominatim" | "explicit-bbox" | "mock"
  sourceUrl?: string;
}

export type SourceType = "open_data" | "licensed_api" | "mock";

export interface CandidateAddress {
  houseNumber?: string;
  street?: string;
  locality?: string;
  city?: string;
  district?: string;
  state?: string;
  postcode?: string;
  country?: string;
  full?: string;
}

export interface BusinessCandidate {
  provider: string; // provider descriptor id, e.g. "osm-overpass"
  providerId: string; // stable id at the provider, e.g. "node/123456"
  name: string;
  category: KalpixCategory;
  subcategory?: string; // e.g. "amenity=restaurant"
  address: CandidateAddress;
  lat: number;
  lon: number;
  phone?: string;
  website?: string;
  email?: string;
  openingHours?: string;
  // provenance
  source: string; // "openstreetmap" | "mock" | "google-places"
  sourceType: SourceType;
  sourceUrl: string;
  collectedAt: Date;
  confidence: number; // 0..1, heuristic completeness score, NOT a verification
  license?: string;
  usageRestrictions?: string;
  rawTags?: Record<string, string>;
}

export interface DiscoverySearchResult {
  candidates: BusinessCandidate[];
  /** Elements returned by the provider but not usable (e.g. no name). */
  skipped: number;
  /** HTTP requests actually made, for UsageEvent accounting. */
  requests: number;
  attribution?: string;
}

export interface BusinessDiscoveryProvider extends Provider {
  search(
    area: ResolvedArea,
    categories: KalpixCategory[],
    opts?: { signal?: AbortSignal },
  ): Promise<Result<DiscoverySearchResult>>;
}

export interface GeocodeResult {
  area: ResolvedArea;
  requests: number;
  cached: boolean;
}

export interface GeocodingProvider extends Provider {
  geocode(query: string, opts?: { signal?: AbortSignal }): Promise<Result<GeocodeResult>>;
}

/** Approximate bbox area in square degrees (used for fair-use size guards). */
export function bboxAreaDeg2(b: BBox): number {
  return Math.abs(b.north - b.south) * Math.abs(b.east - b.west);
}

export function isValidBBox(b: BBox): boolean {
  return (
    [b.south, b.west, b.north, b.east].every((n) => Number.isFinite(n)) &&
    b.south >= -90 &&
    b.north <= 90 &&
    b.west >= -180 &&
    b.east <= 180 &&
    b.south < b.north &&
    b.west < b.east
  );
}

/**
 * Accepts "south,west,north,east" (decimal degrees) typed into the area box, so a tiny test area
 * can be discovered without a geocoding call. Returns null for ordinary place names.
 */
export function parseBBox(input: string): BBox | null {
  const parts = input.split(",").map((s) => s.trim());
  if (parts.length !== 4 || !parts.every((p) => /^-?\d+(\.\d+)?$/.test(p))) return null;
  const [south, west, north, east] = parts.map(Number) as [number, number, number, number];
  const b = { south, west, north, east };
  return isValidBBox(b) ? b : null;
}
