import type { ResolvedArea } from "@kalpix/core";

/** Geocode cache. The worker passes a PostgreSQL-backed one; tests and scripts use memory. */
export interface GeocodeCache {
  get(key: string): Promise<ResolvedArea | null>;
  set(key: string, value: ResolvedArea): Promise<void>;
}

export class MemoryGeocodeCache implements GeocodeCache {
  private readonly map = new Map<string, { value: ResolvedArea; at: number }>();
  constructor(
    private readonly ttlMs = 30 * 24 * 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}
  async get(key: string) {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (this.now() - hit.at > this.ttlMs) {
      this.map.delete(key);
      return null;
    }
    return hit.value;
  }
  async set(key: string, value: ResolvedArea) {
    this.map.set(key, { value, at: this.now() });
  }
}

/** Cache key: case, whitespace and punctuation-insensitive. */
export function geocodeCacheKey(query: string): string {
  return query
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
