# @kalpix/providers

Discovery (Phase 3) and website research (Phase 4) provider adapters and helpers for Kalpix. Pure TypeScript, no database access: the worker (`apps/worker`) and the admin app wire these to PostgreSQL.

## Contents

| File                               | What it does                                                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `src/osm/overpass.ts`              | OSM Overpass discovery adapter: builds a per-category query for a bounding box, rate-limited (>= 2 s between queries), retries 429/5xx |
| `src/osm/nominatim.ts`             | Nominatim geocoder for place names: 1 req/s, identifying User-Agent with contact email, country filter, pluggable cache                |
| `src/osm/normalize.ts`             | Turns OSM elements into normalised businesses: address parts, Indian phone format, website, completeness `confidence`, provenance      |
| `src/config/category-tags.json`    | Kalpix category to OSM tag map (e.g. `restaurants` -> `amenity=restaurant/cafe/fast_food...`)                                          |
| `src/categories.ts`                | Category labels and tag matching                                                                                                       |
| `src/dedupe.ts`                    | Duplicate detection: same provider id, or same category < 50 m apart with name similarity >= 0.85 and no conflicting numbers           |
| `src/rate-limiter.ts`              | Serialising minimum-interval limiter                                                                                                   |
| `src/http.ts`                      | `fetchWithRetry`: per-attempt timeout, exponential backoff, honours `Retry-After`, never retries other 4xx                             |
| `src/cache.ts`                     | Geocode cache interface + in-memory cache (the worker uses a PostgreSQL-backed one)                                                    |
| `src/mock.ts`                      | Deterministic MOCK provider for tests/CI; every record is named "MOCK …"; refused when `APP_ENV=production`                            |
| `src/google-places.ts`             | Google Places **stub**: paid, disabled, `search()` always fails; never makes a request                                                 |
| `src/factory.ts`                   | Maps `DISCOVERY_PROVIDER` (`overpass` / `mock` / `google_places`) to a provider stack                                                  |
| `src/csv.ts`                       | RFC 4180 CSV writer with spreadsheet formula-injection guarding                                                                        |
| `src/research/ssrf.ts`             | SSRF guard: http/https + web ports only, no credentials, blocks private/loopback/link-local/CGNAT/multicast/NAT64/6to4 addresses       |
| `src/research/transport.ts`        | node:http(s) GET with the IP check in the socket DNS lookup (no rebinding window), decompression with a byte cap, error classification |
| `src/research/robots.ts`           | robots.txt parser/matcher (RFC 9309: product-token group, longest match, `*`/`$`, Crawl-delay)                                         |
| `src/research/fetcher.ts`          | Polite fetcher: KalpixBot UA, robots cache per origin, per-host delay, <= 5 redirects re-checked per hop                               |
| `src/research/extract.ts`          | cheerio extraction: JSON-LD, microdata, meta/og, tel/mailto, emails (de-obfuscated), Indian phones (E.164), social, WhatsApp           |
| `src/research/signals.ts`          | Tech hints (WordPress, Wix, Shopify, Blogger ...) and Last-Modified parsing                                                            |
| `src/research/http-research.ts`    | `HttpResearchProvider` (`http-extractor`): homepage + likely contact/about pages, signals, score-free summary                          |
| `src/research/mock-research.ts`    | Deterministic MOCK research provider (`mock-research`); refused in production                                                          |
| `src/research/research-factory.ts` | Maps `RESEARCH_PROVIDER` (`http` / `mock`) to a provider; builds the User-Agent from `RESEARCH_USER_AGENT_CONTACT`                     |

## Data and licences

OSM data is © OpenStreetMap contributors, ODbL 1.0. Every normalised record keeps `source`, `sourceUrl`, `license` and `collectedAt`. Public Overpass and Nominatim servers have usage policies (see `docs/FREE_VS_PAID_TOOLS.md`); commercial-use terms are confirmed by the owner before the providers can be enabled.

Offline fallback (not implemented): a Geofabrik "India – Southern Zone" or openstreetmap.fr Karnataka `.osm.pbf` extract could be imported if the public Overpass servers are unreachable.

## Tests

```bash
pnpm -F @kalpix/providers test   # unit tests, including a recorded Overpass fixture (src/__fixtures__)
```

No test makes a live network call: research tests use HTML fixtures (`src/__fixtures__/research`) and a fake transport. Live Overpass/Nominatim responses were not verified from the build environment.
