# API Documentation

## HTTP

| Route         | Method   | Purpose                                                                                    |
| ------------- | -------- | ------------------------------------------------------------------------------------------ |
| `/api/auth/*` | GET/POST | Better Auth: sign-in, sign-out, session, two-factor enable/verify/disable, admin endpoints |

Used by the dashboard: `POST /api/auth/sign-in/email`, `POST /api/auth/sign-out`, `POST /api/auth/two-factor/enable`, `POST /api/auth/two-factor/verify-totp`, `POST /api/auth/two-factor/disable`. Public `sign-up/email` is disabled (400). Auth routes are rate limited, with a stricter limit on sign-in.

### Authentication for all non-auth API routes

The middleware checks for a session cookie first: a `/api/*` request without one gets `401` with body `{"error":"unauthorized"}` (no redirect); pages without one are redirected (307) to `/login`. Every route then re-validates the session server-side (`401 {"error":"Not signed in"}` if the cookie is stale) and checks RBAC (`403`).

### Discovery (Phase 3)

| Route                    | Method | Permission                               | Purpose                                                         |
| ------------------------ | ------ | ---------------------------------------- | --------------------------------------------------------------- |
| `/api/discovery/runs`    | GET    | `dashboard:read` (any signed-in role)    | 50 most recent runs; `?id=<uuid>` returns one run (404 if none) |
| `/api/discovery/runs`    | POST   | `discovery:run` (operator, admin, owner) | Queue a discovery run                                           |
| `/api/businesses/export` | GET    | `businesses:export` (admin, owner)       | CSV of the filtered business list                               |

**POST `/api/discovery/runs`** body (JSON):

```json
{
  "area": "Tilakwadi, Belagavi | 15.84,74.49,15.88,74.53",
  "categories": ["restaurants", "garages"],
  "provider": "overpass | mock | google_places (optional; default DISCOVERY_PROVIDER)",
  "idempotencyKey": "optional, 8-64 chars [A-Za-z0-9-]"
}
```

- Categories: `restaurants, hotels, hospitals, clinics, manufacturers, retail, supermarkets, education, real_estate, automobile, garages, professional_services`.
- Responses: `202 {run, created: true}` when queued; `200 {run, created: false}` when the same `idempotencyKey` was seen before, or an identical run (same area, provider and categories) is still queued or running; `400` invalid body or bounding box larger than `DISCOVERY_MAX_BBOX_DEG2`; `403` cross-origin `Origin` header or missing permission; `409` provider not ready (not enabled, commercial use unverified, MOCK in production, Google Places) or a place name given without Nominatim enabled.
- Audit: `discovery.run_start` (area, categories, provider). Retry and cancel are server actions audited as `discovery.run_retry` / `discovery.run_cancel`.
- The run is processed by the worker (`pnpm worker` or `pnpm worker:once`), not by the request.

**GET `/api/businesses/export`** query: `q` (search), `category`, `website` (`yes`/`no`), `phone` (`yes`/`no`), `run` (run id), same as the Businesses page filters. Returns `text/csv` (`kalpix-businesses-YYYY-MM-DD.csv`, `cache-control: no-store`), max 50,000 rows, with provenance columns (provider, provider_id, source, source_type, source_url, license, attribution, collected_at, last_seen_at). OSM rows carry "© OpenStreetMap contributors, ODbL". Audit: `business.export` (filters, row count, truncated flag).

## Server actions

Every action validates with zod, checks RBAC server-side and writes an audit entry.

| Action                        | Permission       | Rule                                                                                     |
| ----------------------------- | ---------------- | ---------------------------------------------------------------------------------------- |
| toggleProvider                | providers:manage | Enabling needs keys present and commercial terms verified; paid/freemium needs the owner |
| setCommercialVerified         | owner            | Unverifying also disables                                                                |
| updateProviderLimits          | providers:manage | Monthly units, budget, fallback                                                          |
| createTeamMember              | users:manage     | Admins cannot create owners                                                              |
| changeRole                    | users:manage     | No self-change; at least one owner remains                                               |
| setSuspended                  | users:manage     | Revokes all sessions                                                                     |
| updateSettings                | settings:write   | Only the owner can switch an approval rule off                                           |
| createPackage / togglePackage | pricing:manage   | DEMO packages cannot be activated                                                        |
| startDiscoveryRun             | discovery:run    | Same rules as POST /api/discovery/runs (one idempotency key per rendered form)           |
| retryDiscoveryRun             | discovery:run    | Failed or cancelled runs only; resumes from completed categories                         |
| cancelDiscoveryRun            | discovery:run    | Queued or running runs                                                                   |

## Internal modules

- `@kalpix/config`: `loadEnv`, `integrationStatus`.
- `@kalpix/core`: `Provider`, `ProviderDescriptor`, `Result`, `canEnable`, discovery contracts and `KALPIX_CATEGORIES`.
- `@kalpix/providers`: Overpass, Nominatim, MOCK and Google Places (stub) adapters, normaliser, dedupe, rate limiter, CSV (see `packages/providers/README.md`).
- `apps/admin/src/lib/rbac.ts`: `can`, `canAssignRole`, `isAdminRole`.
- `apps/admin/src/lib/provider-registry.ts`: default catalogue, `secretStatus` (names only).

## Scripts

`pnpm doctor`, `pnpm db:check`, `pnpm db:backup`, `pnpm db:deploy`, `pnpm db:seed`, `pnpm dev`, `pnpm build`, `pnpm start`, `pnpm e2e`, `pnpm worker`, `pnpm worker:once`.
