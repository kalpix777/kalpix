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

### Research (Phase 4)

| Route                | Method | Permission                              | Purpose                                                         |
| -------------------- | ------ | --------------------------------------- | --------------------------------------------------------------- |
| `/api/research/runs` | GET    | `dashboard:read` (any signed-in role)   | 50 most recent runs; `?id=<uuid>` returns one run (404 if none) |
| `/api/research/runs` | POST   | `research:run` (operator, admin, owner) | Queue a website-research run                                    |

**POST `/api/research/runs`** body (JSON), one of three scopes:

```text
{ "scope": "discovery_run", "discoveryRunId": "<uuid>" }
{ "scope": "filter", "filter": { "category": "restaurants", "hasWebsite": true, "staleAfterDays": 30, "limit": 100 } }
{ "scope": "businesses", "businessIds": ["<uuid>", "..."] }
```

plus optional `"provider": "http | mock"` (default `RESEARCH_PROVIDER`) and `"idempotencyKey"` (8-64 chars `[A-Za-z0-9-]`). `limit` and `businessIds` are capped at 500; `staleAfterDays` is 1-3650 and also matches businesses never researched.

- Responses: `202 {run, created: true}` when queued; `200 {run, created: false}` for a repeated `idempotencyKey` or an identical run (same provider and scope) still queued or running; `400` invalid body; `401` not signed in (`{"error":"unauthorized"}` from the middleware without a cookie); `403` cross-origin `Origin` or missing permission; `404` unknown discovery run; `409` provider not ready (HTTP extractor disabled, `RESEARCH_USER_AGENT_CONTACT` unset, MOCK in production).
- Run fields: status, scope, total/processed counts, outcome counts (ok, noWebsite, broken, blocked, error), factCount, newFactCount, conflictCount (businesses with conflicting values), requestCount, attempts, error, timestamps.
- Audit: `research.run_start` (provider, scope). The worker (`pnpm worker` / `pnpm worker:once`) does the fetching, not the request.

### Qualification (Phase 5)

| Route                     | Method | Permission                                   | Purpose                                                         |
| ------------------------- | ------ | -------------------------------------------- | --------------------------------------------------------------- |
| `/api/qualification/runs` | GET    | `dashboard:read` (any signed-in role)        | 50 most recent runs; `?id=<uuid>` returns one run (404 if none) |
| `/api/qualification/runs` | POST   | `qualification:run` (operator, admin, owner) | Queue a verification + qualification run                        |

**POST `/api/qualification/runs`** body (JSON), one of four scopes:

```text
{ "scope": "discovery_run", "discoveryRunId": "<uuid>" }
{ "scope": "research_run", "researchRunId": "<uuid>" }
{ "scope": "filter", "filter": { "category": "restaurants", "city": "Belagavi", "hasWebsite": true, "tier": "warm", "staleAfterDays": 30, "limit": 200 } }
{ "scope": "businesses", "businessIds": ["<uuid>", "..."] }
```

plus optional `"ai": "none | mock | ollama | gemini"` (omitted = `QUALIFICATION_AI_PROVIDER`, default `none` = rules only) and `"idempotencyKey"` (8-64 chars `[A-Za-z0-9-]`). `limit` and `businessIds` are capped at `QUALIFICATION_MAX_BUSINESSES_PER_RUN`; `staleAfterDays` (1-3650) also matches businesses never qualified.

- Responses: `202 {run, created: true}` when queued (`run`: id, status, scopeType, aiProvider, rulesVersion); `200 {run, created: false}` for a repeated `idempotencyKey` or an identical run (same scope and AI provider) still queued or running; `400` invalid body; `401` not signed in; `403` cross-origin `Origin` or missing permission; `404` unknown discovery/research run; `409` the chosen AI provider is not ready (not enabled by the owner, commercial terms not confirmed, `GEMINI_API_KEY` / `OLLAMA_BASE_URL` missing, MOCK in production) or the configured default is invalid.
- Run fields: status, scope, AI provider, prompt and rules versions, total/processed counts, tier counts (hot, warm, cold, disqualified), errorCount, facts checked/verified/invalid, AI ok/error counts, AI input/output tokens and cost (minor units), attempts, error, timestamps.
- AI output never changes the score or tier; phone numbers and emails are masked in prompts; disqualified businesses are not sent to AI.
- Audit: `qualification.run_start` (scope, AI provider, rules version). The worker (`pnpm worker` / `pnpm worker:once`) verifies facts, scores and calls the model, not the request.

## Server actions

Every action validates with zod, checks RBAC server-side and writes an audit entry.

| Action                        | Permission        | Rule                                                                                                                                                                                          |
| ----------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| toggleProvider                | providers:manage  | Enabling needs keys present and commercial terms verified; paid/freemium needs the owner                                                                                                      |
| setCommercialVerified         | owner             | Unverifying also disables                                                                                                                                                                     |
| updateProviderLimits          | providers:manage  | Monthly units, budget, fallback                                                                                                                                                               |
| createTeamMember              | users:manage      | Admins cannot create owners                                                                                                                                                                   |
| changeRole                    | users:manage      | No self-change; at least one owner remains                                                                                                                                                    |
| setSuspended                  | users:manage      | Revokes all sessions                                                                                                                                                                          |
| updateSettings                | settings:write    | Only the owner can switch an approval rule off                                                                                                                                                |
| createPackage / togglePackage | pricing:manage    | DEMO packages cannot be activated                                                                                                                                                             |
| startDiscoveryRun             | discovery:run     | Same rules as POST /api/discovery/runs (one idempotency key per rendered form)                                                                                                                |
| retryDiscoveryRun             | discovery:run     | Failed or cancelled runs only; resumes from completed categories                                                                                                                              |
| cancelDiscoveryRun            | discovery:run     | Queued or running runs                                                                                                                                                                        |
| startResearchRun              | research:run      | Same rules as POST /api/research/runs (form: discovery run, filter or one business)                                                                                                           |
| retryResearchRun              | research:run      | Failed or cancelled runs only; resumes with businesses not yet done                                                                                                                           |
| cancelResearchRun             | research:run      | Queued or running runs                                                                                                                                                                        |
| startQualificationRun         | qualification:run | Same rules as POST /api/qualification/runs (form on /leads, or "Qualify" on a business); an identical active run is an error                                                                  |
| retryQualificationRun         | qualification:run | Failed or cancelled runs only; resumes after the last qualified business                                                                                                                      |
| cancelQualificationRun        | qualification:run | Queued or running runs                                                                                                                                                                        |
| overrideFact                  | facts:verify      | Sets a fact to verified / unverified / conflicting / invalid; reason 3-500 chars required; keeps the previous automatic result; audited `fact.verify_override`; score changes on the next run |
| clearOverride                 | facts:verify      | Removes an override (fact becomes unverified until the next automatic pass); audited `fact.verify_override_clear`                                                                             |

## Internal modules

- `@kalpix/config`: `loadEnv`, `integrationStatus`.
- `@kalpix/core`: `Provider`, `ProviderDescriptor`, `Result`, `canEnable`, discovery and research contracts, `KALPIX_CATEGORIES`, `detectConflicts`, fact verification and rules qualification (`verification.ts`, `qualification.ts`), model contract (`model.ts`).
- `@kalpix/providers`: Overpass, Nominatim, MOCK and Google Places (stub) adapters, normaliser, dedupe, rate limiter, CSV; website research (HTTP + schema.org extractor, robots, SSRF guard, MOCK research); model adapters (MOCK, Ollama, Gemini) and the MX resolver (see `packages/providers/README.md`).
- `apps/admin/src/lib/rbac.ts`: `can`, `canAssignRole`, `isAdminRole`.
- `apps/admin/src/lib/provider-registry.ts`: default catalogue, `secretStatus` (names only).

## Scripts

`pnpm doctor`, `pnpm db:check`, `pnpm db:backup`, `pnpm db:deploy`, `pnpm db:seed`, `pnpm dev`, `pnpm build`, `pnpm start`, `pnpm e2e`, `pnpm worker`, `pnpm worker:once`.
