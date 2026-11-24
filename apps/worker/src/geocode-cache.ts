import type { PrismaClient } from "@prisma/client";
import type { ResolvedArea } from "@kalpix/core";
import type { GeocodeCache } from "@kalpix/providers";

const TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Nominatim results shared by every worker process; entries expire after 30 days. */
export class PrismaGeocodeCache implements GeocodeCache {
  constructor(private readonly db: PrismaClient) {}

  async get(key: string): Promise<ResolvedArea | null> {
    const row = await this.db.geocodeCache.findUnique({ where: { key } });
    if (!row || Date.now() - row.fetchedAt.getTime() > TTL_MS) return null;
    return {
      query: row.query,
      displayName: row.displayName,
      bbox: { south: row.south, west: row.west, north: row.north, east: row.east },
      source: row.provider,
      sourceUrl: row.sourceUrl ?? undefined,
    };
  }

  async set(key: string, v: ResolvedArea): Promise<void> {
    const data = {
      query: v.query,
      provider: v.source,
      displayName: v.displayName,
      ...v.bbox,
      sourceUrl: v.sourceUrl ?? null,
      fetchedAt: new Date(),
    };
    await this.db.geocodeCache.upsert({ where: { key }, update: data, create: { key, ...data } });
  }
}
