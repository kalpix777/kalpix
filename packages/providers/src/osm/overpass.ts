import {
  bboxAreaDeg2,
  fail,
  isValidBBox,
  ok,
  type BusinessCandidate,
  type BusinessDiscoveryProvider,
  type DiscoverySearchResult,
  type KalpixCategory,
  type ProviderDescriptor,
  type ProviderHealth,
  type ResolvedArea,
  type Result,
} from "@kalpix/core";
import { buildOverpassQuery, CATEGORY_MAP, type CategoryMap } from "../categories";
import { fetchWithRetry, HttpError, type FetchLike } from "../http";
import { RateLimiter, type Sleep } from "../rate-limiter";
import { normalizeOsmElement, OSM_ATTRIBUTION, type OverpassElement } from "./normalize";

export const OVERPASS_DESCRIPTOR: ProviderDescriptor = {
  id: "osm-overpass",
  name: "OpenStreetMap Overpass",
  category: "discovery",
  costTier: "free",
  requiredSecrets: [],
  commercialUseVerified: false, // the owner confirms ODbL + instance fair-use terms in the UI
};

export const DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter";

export interface OverpassOptions {
  endpoint?: string;
  userAgent: string;
  /** Refuse areas larger than this many square degrees (fair use of the public instance). */
  maxBboxDeg2?: number;
  queryTimeoutSec?: number;
  requestTimeoutMs?: number;
  retries?: number;
  minIntervalMs?: number;
  fetchImpl?: FetchLike;
  sleep?: Sleep;
  now?: () => Date;
  map?: CategoryMap;
  limiter?: RateLimiter;
}

export class OverpassDiscoveryProvider implements BusinessDiscoveryProvider {
  readonly descriptor = OVERPASS_DESCRIPTOR;
  private readonly limiter: RateLimiter;
  readonly endpoint: string;
  /** Total HTTP attempts made by this instance, including failed ones (for usage accounting). */
  requestsMade = 0;

  constructor(private readonly opts: OverpassOptions) {
    this.endpoint = opts.endpoint || DEFAULT_OVERPASS_URL;
    // Public instance policy: about one concurrent query per user; keep a gap between queries.
    this.limiter =
      opts.limiter ?? new RateLimiter(opts.minIntervalMs ?? 2000, Date.now, opts.sleep);
  }

  async healthCheck(): Promise<ProviderHealth> {
    const url = this.endpoint.replace(/\/interpreter\/?$/, "/status");
    try {
      const { response } = await fetchWithRetry(
        url,
        { headers: { "user-agent": this.opts.userAgent } },
        {
          timeoutMs: 10_000,
          retries: 0,
          baseDelayMs: 0,
          maxDelayMs: 0,
          fetchImpl: this.opts.fetchImpl,
        },
      );
      const text = await response.text();
      return { status: "connected", checkedAt: new Date(), detail: text.slice(0, 120) };
    } catch (err) {
      return { status: "error", checkedAt: new Date(), detail: (err as Error).message };
    }
  }

  async search(
    area: ResolvedArea,
    categories: KalpixCategory[],
    o: { signal?: AbortSignal } = {},
  ): Promise<Result<DiscoverySearchResult>> {
    if (categories.length === 0) return fail("No categories selected");
    if (!isValidBBox(area.bbox)) return fail("Invalid bounding box");
    const max = this.opts.maxBboxDeg2 ?? 0.25;
    const size = bboxAreaDeg2(area.bbox);
    if (size > max)
      return fail(
        `Area too large for the public Overpass instance (${size.toFixed(3)} sq. deg > ${max}). Choose a smaller area.`,
      );
    const query = buildOverpassQuery(categories, area.bbox, {
      timeoutSec: this.opts.queryTimeoutSec ?? 60,
      map: this.opts.map,
    });
    let attempts = 0;
    try {
      const json = await this.limiter.schedule(async () => {
        const r = await fetchWithRetry(
          this.endpoint,
          {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              accept: "application/json",
              "user-agent": this.opts.userAgent,
            },
            body: new URLSearchParams({ data: query }).toString(),
          },
          {
            timeoutMs: this.opts.requestTimeoutMs ?? 90_000,
            retries: this.opts.retries ?? 3,
            baseDelayMs: 5_000,
            maxDelayMs: 60_000,
            fetchImpl: this.opts.fetchImpl,
            sleep: this.opts.sleep,
            signal: o.signal,
          },
        );
        attempts = r.attempts;
        this.requestsMade += r.attempts;
        return (await r.response.json()) as { elements?: OverpassElement[]; remark?: string };
      });
      if (json.remark && /error|timed out|out of memory/i.test(json.remark))
        return fail(`Overpass runtime error: ${json.remark}`);
      const collectedAt = (this.opts.now ?? (() => new Date()))();
      const seen = new Set<string>();
      const candidates: BusinessCandidate[] = [];
      let skipped = 0;
      for (const el of json.elements ?? []) {
        const c = normalizeOsmElement(el, categories, collectedAt, this.opts.map ?? CATEGORY_MAP);
        if (!c || seen.has(c.providerId)) {
          skipped++;
          continue;
        }
        seen.add(c.providerId);
        candidates.push(c);
      }
      return ok({ candidates, skipped, requests: attempts, attribution: OSM_ATTRIBUTION });
    } catch (err) {
      const e = err as HttpError | Error;
      if (e instanceof HttpError) this.requestsMade += e.attempts;
      return fail(`Overpass request failed: ${e.message}`);
    }
  }
}
