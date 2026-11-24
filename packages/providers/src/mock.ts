import {
  ok,
  parseBBox,
  type BusinessCandidate,
  type BusinessDiscoveryProvider,
  type DiscoverySearchResult,
  type GeocodeResult,
  type GeocodingProvider,
  type KalpixCategory,
  type ProviderDescriptor,
  type ProviderHealth,
  type ResolvedArea,
  type Result,
} from "@kalpix/core";
import { categoryLabel } from "./categories";

/**
 * Deterministic offline provider for tests and CI (DISCOVERY_PROVIDER=mock). Every record is
 * named "MOCK ..." and stored with source "mock" so it can never be mistaken for real data.
 * Refused when APP_ENV=production (see factory.ts).
 */
export const MOCK_DESCRIPTOR: ProviderDescriptor = {
  id: "mock-discovery",
  name: "Mock discovery (tests only)",
  category: "discovery",
  costTier: "free",
  requiredSecrets: [],
  commercialUseVerified: true,
};

const MOCK_BBOX = { south: 15.84, west: 74.49, north: 15.88, east: 74.53 };

export class MockGeocoder implements GeocodingProvider {
  readonly descriptor = { ...MOCK_DESCRIPTOR, id: "mock-geocoder" };
  requestsMade = 0;
  async healthCheck(): Promise<ProviderHealth> {
    return { status: "connected", checkedAt: new Date(), detail: "mock" };
  }
  async geocode(query: string): Promise<Result<GeocodeResult>> {
    const area: ResolvedArea = {
      query,
      displayName: `MOCK area for "${query}"`,
      bbox: parseBBox(query) ?? MOCK_BBOX,
      source: "mock",
    };
    return ok({ area, requests: 0, cached: false });
  }
}

export class MockDiscoveryProvider implements BusinessDiscoveryProvider {
  readonly descriptor = MOCK_DESCRIPTOR;
  requestsMade = 0;
  /** Test hook: categories listed here fail once (to exercise resumability). */
  failOnce = new Set<KalpixCategory>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async healthCheck(): Promise<ProviderHealth> {
    return { status: "connected", checkedAt: new Date(), detail: "mock" };
  }

  async search(
    area: ResolvedArea,
    categories: KalpixCategory[],
  ): Promise<Result<DiscoverySearchResult>> {
    for (const c of categories)
      if (this.failOnce.has(c)) {
        this.failOnce.delete(c);
        return { ok: false, error: `MOCK failure for ${c}` };
      }
    this.requestsMade++;
    const lat0 = (area.bbox.south + area.bbox.north) / 2;
    const lon0 = (area.bbox.west + area.bbox.east) / 2;
    const collectedAt = this.now();
    const out: BusinessCandidate[] = [];
    categories.forEach((cat, ci) => {
      const label = categoryLabel(cat);
      for (let i = 1; i <= 3; i++) {
        const lat = lat0 + ci * 0.002 + i * 0.0007;
        const lon = lon0 + ci * 0.002;
        out.push({
          provider: MOCK_DESCRIPTOR.id,
          providerId: `mock/${cat}/${i}`,
          name: `MOCK ${label} ${i}`,
          category: cat,
          subcategory: `mock=${cat}`,
          address: { street: `Mock Street ${i}`, city: "Mockpur", postcode: "000000" },
          lat,
          lon,
          phone: i === 1 ? "+910000000000" : undefined,
          website: i === 1 ? `https://example.com/mock-${cat}-${i}` : undefined,
          source: "mock",
          sourceType: "mock",
          sourceUrl: `https://example.com/mock/${cat}/${i}`,
          collectedAt,
          confidence: i === 1 ? 0.8 : 0.5,
          usageRestrictions: "Test fixture. Not real data.",
        });
      }
      // A near-duplicate of #1 under another id ~11 m away: must be merged by fuzzy dedupe.
      out.push({
        ...out[out.length - 3]!,
        providerId: `mock/${cat}/1-dup`,
        name: `Mock ${label} 1.`,
        lat: lat0 + ci * 0.002 + 0.0007 + 0.0001,
      });
    });
    return ok({ candidates: out, skipped: 0, requests: 1, attribution: "Mock data" });
  }
}
