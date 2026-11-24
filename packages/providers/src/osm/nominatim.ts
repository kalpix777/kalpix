import {
  fail,
  isValidBBox,
  ok,
  type GeocodeResult,
  type GeocodingProvider,
  type ProviderDescriptor,
  type ProviderHealth,
  type Result,
} from "@kalpix/core";
import { geocodeCacheKey, MemoryGeocodeCache, type GeocodeCache } from "../cache";
import { fetchWithRetry, HttpError, type FetchLike } from "../http";
import { RateLimiter, type Sleep } from "../rate-limiter";

export const NOMINATIM_DESCRIPTOR: ProviderDescriptor = {
  id: "nominatim",
  name: "Nominatim",
  category: "discovery",
  costTier: "free",
  requiredSecrets: ["NOMINATIM_CONTACT_EMAIL"],
  commercialUseVerified: false,
};

export const DEFAULT_NOMINATIM_URL = "https://nominatim.openstreetmap.org";

export interface NominatimOptions {
  baseUrl?: string;
  contactEmail?: string;
  appName?: string;
  appVersion?: string;
  countryCodes?: string; // e.g. "in"
  requestTimeoutMs?: number;
  retries?: number;
  fetchImpl?: FetchLike;
  sleep?: Sleep;
  cache?: GeocodeCache;
  limiter?: RateLimiter;
}

interface NominatimHit {
  display_name: string;
  boundingbox: [string, string, string, string]; // south, north, west, east
  osm_type?: string;
  osm_id?: number;
}

/**
 * Area name -> bounding box. Usage policy (https://operations.osmfoundation.org/policies/nominatim/):
 * max 1 request/second, a User-Agent that identifies the application with contact details,
 * results cached, no bulk geocoding. A missing contact email is a hard error, not a warning.
 */
export class NominatimGeocoder implements GeocodingProvider {
  readonly descriptor = NOMINATIM_DESCRIPTOR;
  readonly baseUrl: string;
  requestsMade = 0;
  private readonly limiter: RateLimiter;
  private readonly cache: GeocodeCache;

  constructor(private readonly opts: NominatimOptions) {
    this.baseUrl = (opts.baseUrl || DEFAULT_NOMINATIM_URL).replace(/\/+$/, "");
    // 1 req/s is the policy maximum; keep a small margin.
    this.limiter = opts.limiter ?? new RateLimiter(1100, Date.now, opts.sleep);
    this.cache = opts.cache ?? new MemoryGeocodeCache();
  }

  get userAgent(): string {
    return `${this.opts.appName ?? "Kalpix"}/${this.opts.appVersion ?? "0.1"} (${this.opts.contactEmail ?? "no-contact"})`;
  }

  async healthCheck(): Promise<ProviderHealth> {
    if (!this.opts.contactEmail)
      return {
        status: "not_configured",
        checkedAt: new Date(),
        detail: "NOMINATIM_CONTACT_EMAIL missing",
      };
    return { status: "disabled", checkedAt: new Date(), detail: "Checked when a run geocodes" };
  }

  async geocode(query: string, o: { signal?: AbortSignal } = {}): Promise<Result<GeocodeResult>> {
    const q = query.trim();
    if (q.length < 2 || q.length > 200) return fail("Area must be 2-200 characters");
    const key = geocodeCacheKey(q);
    const cached = await this.cache.get(key);
    if (cached) return ok({ area: cached, requests: 0, cached: true });
    if (!this.opts.contactEmail?.includes("@"))
      return fail(
        "NOMINATIM_CONTACT_EMAIL is not set. Nominatim's usage policy requires contact details; set it in .env, or enter the area as a bounding box (south,west,north,east).",
      );
    const params = new URLSearchParams({
      q,
      format: "jsonv2",
      limit: "1",
      email: this.opts.contactEmail,
    });
    if (this.opts.countryCodes) params.set("countrycodes", this.opts.countryCodes);
    const url = `${this.baseUrl}/search?${params}`;
    try {
      const hits = await this.limiter.schedule(async () => {
        const r = await fetchWithRetry(
          url,
          { headers: { "user-agent": this.userAgent, accept: "application/json" } },
          {
            timeoutMs: this.opts.requestTimeoutMs ?? 20_000,
            retries: this.opts.retries ?? 2,
            baseDelayMs: 2_000,
            maxDelayMs: 30_000,
            fetchImpl: this.opts.fetchImpl,
            sleep: this.opts.sleep,
            signal: o.signal,
          },
        );
        this.requestsMade += r.attempts;
        return (await r.response.json()) as NominatimHit[];
      });
      const hit = hits[0];
      if (!hit) return fail(`No place found for "${q}"`);
      const [s, n, w, e] = hit.boundingbox.map(Number) as [number, number, number, number];
      const bbox = { south: s, north: n, west: w, east: e };
      if (!isValidBBox(bbox)) return fail(`Nominatim returned an invalid bounding box for "${q}"`);
      const area = {
        query: q,
        displayName: hit.display_name,
        bbox,
        source: "nominatim",
        sourceUrl:
          hit.osm_type && hit.osm_id
            ? `https://www.openstreetmap.org/${hit.osm_type}/${hit.osm_id}`
            : undefined,
      };
      await this.cache.set(key, area);
      return ok({ area, requests: 1, cached: false });
    } catch (err) {
      if (err instanceof HttpError) this.requestsMade += err.attempts;
      return fail(`Nominatim request failed: ${(err as Error).message}`);
    }
  }
}
