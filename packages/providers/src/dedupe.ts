/**
 * Duplicate detection for discovered businesses.
 * 1. Exact: same provider + providerId (also enforced by a unique index in the database).
 * 2. Fuzzy: same category, under 50 m apart, and normalised names at least 0.85 similar
 *    (character-bigram Dice, order-insensitive), with no conflicting numbers in the names
 *    ("Clinic 1" vs "Clinic 2" are different businesses).
 */
export const DEFAULT_MAX_DISTANCE_M = 50;
export const DEFAULT_MIN_SIMILARITY = 0.85;

const STOP = new Set([
  "the",
  "pvt",
  "pvt.",
  "private",
  "ltd",
  "limited",
  "llp",
  "inc",
  "co",
  "company",
  "and",
]);

export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((t) => t && !STOP.has(t))
    .join(" ");
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = s.replace(/\s+/g, " ");
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

export function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const [g, n] of A) inter += Math.min(n, B.get(g) ?? 0);
  const total =
    [...A.values()].reduce((x, y) => x + y, 0) + [...B.values()].reduce((x, y) => x + y, 0);
  return (2 * inter) / total;
}

/** 0..1, order-insensitive ("Hotel Sanman" ~ "Sanman Hotel"). */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  const sorted = (s: string) => s.split(" ").sort().join(" ");
  return Math.max(dice(na, nb), dice(sorted(na), sorted(nb)));
}

const numbers = (s: string) => (normalizeName(s).match(/\d+/g) ?? []).join(",");

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_008.8;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Degree box around a point, for a cheap indexed database prefilter before haversine. */
export function boxAround(lat: number, lon: number, meters: number) {
  const dLat = meters / 111_320;
  const dLon = meters / (111_320 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLon: lon - dLon, maxLon: lon + dLon };
}

export interface DedupeSubject {
  provider: string;
  providerId: string;
  name: string;
  category: string;
  lat: number;
  lon: number;
}

export interface DedupeMatch<T> {
  match: T;
  reason: "provider_id" | "fuzzy";
  distanceM: number;
  similarity: number;
}

export function findDuplicate<T extends DedupeSubject>(
  c: DedupeSubject,
  existing: readonly T[],
  opts: { maxDistanceM?: number; minSimilarity?: number } = {},
): DedupeMatch<T> | null {
  const maxD = opts.maxDistanceM ?? DEFAULT_MAX_DISTANCE_M;
  const minS = opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  for (const e of existing)
    if (e.provider === c.provider && e.providerId === c.providerId)
      return {
        match: e,
        reason: "provider_id",
        distanceM: haversineMeters(c.lat, c.lon, e.lat, e.lon),
        similarity: 1,
      };
  let best: DedupeMatch<T> | null = null;
  for (const e of existing) {
    if (e.category !== c.category) continue;
    const d = haversineMeters(c.lat, c.lon, e.lat, e.lon);
    if (d >= maxD) continue;
    if (numbers(e.name) !== numbers(c.name)) continue;
    const s = nameSimilarity(c.name, e.name);
    if (s < minS) continue;
    if (!best || s > best.similarity || (s === best.similarity && d < best.distanceM))
      best = { match: e, reason: "fuzzy", distanceM: d, similarity: s };
  }
  return best;
}
