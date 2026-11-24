# @kalpix/providers

Discovery provider adapters and helpers for Kalpix (Phase 3). Pure TypeScript, no database access: the worker (`apps/worker`) and the admin app wire these to PostgreSQL.

## Contents

| File                            | What it does                                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `src/osm/overpass.ts`           | OSM Overpass discovery adapter: builds a per-category query for a bounding box, rate-limited (>= 2 s between queries), retries 429/5xx |
| `src/osm/nominatim.ts`          | Nominatim geocoder for place names: 1 req/s, identifying User-Agent with contact email, country filter, pluggable cache                |
| `src/osm/normalize.ts`          | Turns OSM elements into normalised businesses: address parts, Indian phone format, website, completeness `confidence`, provenance      |
| `src/config/category-tags.json` | Kalpix category to OSM tag map (e.g. `restaurants` -> `amenity=restaurant/cafe/fast_food...`)                                          |
| `src/categories.ts`             | Category labels and tag matching                                                                                                       |
| `src/dedupe.ts`                 | Duplicate detection: same provider id, or same category < 50 m apart with name similarity >= 0.85 and no conflicting numbers           |
| `src/rate-limiter.ts`           | Serialising minimum-interval limiter                                                                                                   |
| `src/http.ts`                   | `fetchWithRetry`: per-attempt timeout, exponential backoff, honours `Retry-After`, never retries other 4xx                             |
| `src/cache.ts`                  | Geocode cache interface + in-memory cache (the worker uses a PostgreSQL-backed one)                                                    |
| `src/mock.ts`                   | Deterministic MOCK provider for tests/CI; every record is named "MOCK …"; refused when `APP_ENV=production`                            |
| `src/google-places.ts`          | Google Places **stub**: paid, disabled, `search()` always fails; never makes a request                                                 |
| `src/factory.ts`                | Maps `DISCOVERY_PROVIDER` (`overpass` / `mock` / `google_places`) to a provider stack                                                  |
| `src/csv.ts`                    | RFC 4180 CSV writer with spreadsheet formula-injection guarding                                                                        |

## Data and licences

OSM data is © OpenStreetMap contributors, ODbL 1.0. Every normalised record keeps `source`, `sourceUrl`, `license` and `collectedAt`. Public Overpass and Nominatim servers have usage policies (see `docs/FREE_VS_PAID_TOOLS.md`); commercial-use terms are confirmed by the owner before the providers can be enabled.

Offline fallback (not implemented): a Geofabrik "India – Southern Zone" or openstreetmap.fr Karnataka `.osm.pbf` extract could be imported if the public Overpass servers are unreachable.

## Tests

```bash
pnpm -F @kalpix/providers test   # unit tests, including a recorded Overpass fixture (src/__fixtures__)
```

No test makes a live network call. Live Overpass/Nominatim responses were not verified from the build environment.
