import {
  canEnable,
  fail,
  type BusinessDiscoveryProvider,
  type DiscoverySearchResult,
  type ProviderDescriptor,
  type ProviderHealth,
  type Result,
} from "@kalpix/core";

export const GOOGLE_PLACES_DESCRIPTOR: ProviderDescriptor = {
  id: "google-places",
  name: "Google Places API",
  category: "discovery",
  costTier: "paid",
  requiredSecrets: ["GOOGLE_PLACES_API_KEY"],
  commercialUseVerified: false,
  fallbackProviderId: "osm-overpass",
};

/**
 * STUB. Paid provider: not built in Phase 3 and never called. It stays disabled until a key exists
 * AND the owner confirms commercial terms (Places data has storage/caching restrictions that the
 * schema must honour before any adapter is written). search() always fails honestly.
 */
export class GooglePlacesDiscoveryProvider implements BusinessDiscoveryProvider {
  readonly descriptor: ProviderDescriptor;

  constructor(
    private readonly env: { GOOGLE_PLACES_API_KEY?: string },
    commercialUseVerified = false,
  ) {
    this.descriptor = { ...GOOGLE_PLACES_DESCRIPTOR, commercialUseVerified };
  }

  canEnable(): Result<true> {
    const configured = new Set(
      this.env.GOOGLE_PLACES_API_KEY?.trim() ? ["GOOGLE_PLACES_API_KEY"] : [],
    );
    return canEnable(this.descriptor, configured);
  }

  async healthCheck(): Promise<ProviderHealth> {
    const c = this.canEnable();
    return {
      status: c.ok ? "disabled" : "not_configured",
      checkedAt: new Date(),
      detail: c.ok ? "Adapter not built yet" : c.error,
    };
  }

  async search(): Promise<Result<DiscoverySearchResult>> {
    const c = this.canEnable();
    if (!c.ok) return fail(`Google Places is disabled: ${c.error}`);
    return fail("Google Places adapter is not built yet (paid provider, awaiting owner approval)");
  }
}
