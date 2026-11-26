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

### CRM and lead management (Phase 6)

All routes return JSON errors `{"error": "..."}` with `400` (validation, rule refused), `401` (not signed in), `403` (cross-origin `Origin` on a write, missing permission, or reopening without admin), `404` (unknown or malformed id), `409` (stale `version`, do-not-contact, already a lead / disqualified) as the other routes. No route sends any message: outreach is Phases 11-12.

| Route                                         | Method         | Permission                     | Purpose                                                                                                                                |
| --------------------------------------------- | -------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/crm/leads`                              | GET            | `crm:read` (viewer+)           | Lead list, 50 per page: `stage`, `assignee` (`me` / `none` / user id), `tier`, `tag`, `overdue`, `stale`, `contactStatus`, `q`, `page` |
| `/api/crm/leads`                              | POST           | `crm:write` (operator+)        | Promote from qualification (idempotent) or create one manual lead                                                                      |
| `/api/crm/leads/export`                       | GET            | `crm:export` (admin, owner)    | CSV of the filtered list (same query as GET list)                                                                                      |
| `/api/crm/leads/import`                       | POST           | `crm:import` (admin, owner)    | CSV import (`text/csv` body or JSON `{csv, dryRun?}`; `?dryRun=1`)                                                                     |
| `/api/crm/leads/[id]`                         | GET / PATCH    | `crm:read` / `crm:write`       | Detail; PATCH `{version, priority?, valueEstimatePaise?, nextFollowUpAt?, lawfulBasisNote?}`                                           |
| `/api/crm/leads/[id]/stage`                   | POST           | `crm:write` (+`crm:reopen`)    | `{version, to, note?, lostReason?}`                                                                                                    |
| `/api/crm/leads/[id]/assign`                  | POST           | `crm:write`                    | `{version, assigneeId \| null}` (assignee: active operator, admin or owner)                                                            |
| `/api/crm/leads/[id]/activities`              | POST           | `crm:write`                    | `{type: note \| call_logged \| meeting_logged, body, occurredAt?}`                                                                     |
| `/api/crm/leads/[id]/activities/[activityId]` | PATCH          | `crm:write`                    | Edit a note `{body}`: author only, within 15 minutes                                                                                   |
| `/api/crm/leads/[id]/tasks`                   | POST           | `crm:write`                    | `{title, dueAt?, assigneeId?}` (default assignee: the creator)                                                                         |
| `/api/crm/leads/[id]/tasks/[taskId]`          | PATCH / DELETE | `crm:write`                    | PATCH `{title?, dueAt?, assigneeId?, status?}`; DELETE cancels (tasks are kept)                                                        |
| `/api/crm/leads/[id]/contacts`                | POST           | `crm:write`                    | `{personName?, role?, phone?, email?, whatsapp?, isPrimary?, sourceFactId?}` (name or a channel required)                              |
| `/api/crm/leads/[id]/contacts/[contactId]`    | PATCH / DELETE | `crm:write`                    | Edit or remove a contact; making one primary demotes the others                                                                        |
| `/api/crm/leads/[id]/tags`                    | PUT            | `crm:write`                    | `{tags: string[]}` replaces the lead's tags (max 20, created on first use, case-insensitively unique)                                  |
| `/api/crm/leads/[id]/dnc`                     | POST           | `crm:write`                    | `{status: do_not_contact \| opted_out, reason, lawfulBasisNote?}` on the lead's business                                               |
| `/api/crm/leads/[id]/dnc`                     | DELETE         | `crm:dnc_clear` (admin, owner) | `{reason}` clears do-not-contact                                                                                                       |
| `/api/crm/tags`                               | GET            | `crm:read`                     | Tags with lead counts                                                                                                                  |
| `/api/crm/assignees`                          | GET            | `crm:read`                     | Active users who can be assigned (operator, admin, owner)                                                                              |

**POST `/api/crm/leads`** body, one of:

```text
{ "scope": "qualification_run", "runId": "<uuid>", "tiers"?: ["hot","warm"], "assign"?: "none|round_robin", "limit"?: 1-1000 }
{ "scope": "businesses", "businessIds": ["<uuid>", "..."], "tiers"?: [...], "assign"?: "..." }
{ "scope": "all", "tiers"?: [...], "assign"?: "...", "limit"?: 1-1000 (default 200) }
{ "scope": "manual", "businessId": "<uuid>", "assigneeId"?: "<user id>", "priority"?: "low|normal|high", "note"?: "..." }
```

- `tiers` defaults to `CRM_PROMOTE_TIERS` (default `hot,warm`); `disqualified` is refused (400). Disqualified businesses, do-not-contact / opted-out businesses and businesses that already have a lead are skipped and counted.
- Promotion responses: `201 {considered, created: [{leadId, businessId, assigneeId}], skipped: {has_lead, tier_not_selected, disqualified, do_not_contact}, tiers}` when at least one lead was created, else `200` with the same shape (idempotent re-runs). Manual: `201 {lead}`; `409` if the business already has a lead or is disqualified; `404` unknown business / run.
- Audit: `crm.lead_promote` (scope, tiers, assign mode, counts, lead ids), `crm.lead_create` (manual).

**Lead detail** (`GET /api/crm/leads/[id]`): lead fields with `business` (incl. latest tier/score, contact status, lawful-basis note), `assignee`, `tags`, `contacts` (with `sourceFact` provenance), `tasks` (with `overdue`), `stageHistory`, latest 200 `activities` (with `editableUntil` for the caller's own notes), `health` (active / stale / closed), `daysSinceActivity`, `followUpOverdue` and `allowedNextStages` for the caller (empty for viewers).

**Stage changes:** the transition matrix and rules are in `docs/DATABASE_SCHEMA.md` (Phase 6). `400` not allowed or missing lost reason, `403` reopening won/lost without admin, `409` do-not-contact (`code: "do_not_contact"`) or stale version. Audit `crm.stage_change` (from, to, reopen, lost reason).

**Concurrency:** PATCH, stage and assign require the lead's current `version`; a mismatch is `409 {"error", "currentVersion"}` and nothing changes.

**Export** (`GET /api/crm/leads/export`): `text/csv` `kalpix-leads-YYYY-MM-DD.csv`, max 50,000 rows, `cache-control: no-store`, formula-injection safe (cells starting with `= + - @` tab or CR get a leading `'`). Phone and email are blank for do-not-contact / opted-out businesses. Audit `crm.export` (filters, rows, truncated).

**Import** (`POST /api/crm/leads/import`): columns (header names case-insensitive; unknown columns are refused) `name`, `category` (required; Kalpix category ids), `phone`, `email`, `whatsapp` (at least one), `website`, `address`, `city`, `state`, `postcode` (6-digit PIN), `lat`, `lon` (both or neither; required to create a new business), `contact_name`, `contact_role`, `priority`, `value_estimate_paise`, `tags` (`;`-separated), `note`, `lawful_basis_note`. Max 1,000 rows / 2 MB. Response `{dryRun, rows, valid, willCreateBusinesses, willLinkBusinesses, skipped: [{line, reason}], errors: [{line, message}], created: [{line, leadId, businessId}]}`; `201` when leads were created, else `200`; `413` over 2 MB; `415` other content types. Audit `crm.lead_import` (counts).

**Do-not-contact:** set by operator+ with a reason (audited `crm.dnc_set`), cleared by admin+ with a reason (`crm.dnc_clear`, `409` if not set). Assignment audit: `crm.assign` (from, to).

## Server actions

Every action validates with zod, checks RBAC server-side and writes an audit entry.

| Action                                                              | Permission                     | Rule                                                                                                                                                                                          |
| ------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| toggleProvider                                                      | providers:manage               | Enabling needs keys present and commercial terms verified; paid/freemium needs the owner                                                                                                      |
| setCommercialVerified                                               | owner                          | Unverifying also disables                                                                                                                                                                     |
| updateProviderLimits                                                | providers:manage               | Monthly units, budget, fallback                                                                                                                                                               |
| createTeamMember                                                    | users:manage                   | Admins cannot create owners                                                                                                                                                                   |
| changeRole                                                          | users:manage                   | No self-change; at least one owner remains                                                                                                                                                    |
| setSuspended                                                        | users:manage                   | Revokes all sessions                                                                                                                                                                          |
| updateSettings                                                      | settings:write                 | Only the owner can switch an approval rule off                                                                                                                                                |
| createPackage / togglePackage                                       | pricing:manage                 | DEMO packages cannot be activated                                                                                                                                                             |
| startDiscoveryRun                                                   | discovery:run                  | Same rules as POST /api/discovery/runs (one idempotency key per rendered form)                                                                                                                |
| retryDiscoveryRun                                                   | discovery:run                  | Failed or cancelled runs only; resumes from completed categories                                                                                                                              |
| cancelDiscoveryRun                                                  | discovery:run                  | Queued or running runs                                                                                                                                                                        |
| startResearchRun                                                    | research:run                   | Same rules as POST /api/research/runs (form: discovery run, filter or one business)                                                                                                           |
| retryResearchRun                                                    | research:run                   | Failed or cancelled runs only; resumes with businesses not yet done                                                                                                                           |
| cancelResearchRun                                                   | research:run                   | Queued or running runs                                                                                                                                                                        |
| startQualificationRun                                               | qualification:run              | Same rules as POST /api/qualification/runs (form on /leads, or "Qualify" on a business); an identical active run is an error                                                                  |
| retryQualificationRun                                               | qualification:run              | Failed or cancelled runs only; resumes after the last qualified business                                                                                                                      |
| cancelQualificationRun                                              | qualification:run              | Queued or running runs                                                                                                                                                                        |
| overrideFact                                                        | facts:verify                   | Sets a fact to verified / unverified / conflicting / invalid; reason 3-500 chars required; keeps the previous automatic result; audited `fact.verify_override`; score changes on the next run |
| clearOverride                                                       | facts:verify                   | Removes an override (fact becomes unverified until the next automatic pass); audited `fact.verify_override_clear`                                                                             |
| promoteLeadsAction / createManualLeadAction                         | crm:write                      | Same rules as POST /api/crm/leads (Promote to CRM on /leads; Add to CRM on /leads and business detail)                                                                                        |
| updateLeadAction / changeLeadStageAction / assignLeadAction         | crm:write (reopen: crm:reopen) | Same rules as PATCH, stage and assign; the form carries `version`; datetime-local values use the browser offset (`tzOffset`, default IST)                                                     |
| addLeadActivityAction / editLeadNoteAction                          | crm:write                      | Timeline entries; notes editable by the author for 15 minutes                                                                                                                                 |
| createLeadTaskAction / updateLeadTaskAction                         | crm:write                      | Tasks; status `cancelled` is the delete                                                                                                                                                       |
| saveLeadContactAction / deleteLeadContactAction / setLeadTagsAction | crm:write                      | Contacts and tags (comma-separated)                                                                                                                                                           |
| setLeadDncAction / clearLeadDncAction                               | crm:write / crm:dnc_clear      | Do-not-contact set (operator+) and clear (admin+), reason required, audited                                                                                                                   |

## Internal modules

- `@kalpix/config`: `loadEnv`, `integrationStatus`.
- `@kalpix/core`: `Provider`, `ProviderDescriptor`, `Result`, `canEnable`, discovery and research contracts, `KALPIX_CATEGORIES`, `detectConflicts`, fact verification and rules qualification (`verification.ts`, `qualification.ts`), model contract (`model.ts`).
- `@kalpix/providers`: Overpass, Nominatim, MOCK and Google Places (stub) adapters, normaliser, dedupe, rate limiter, CSV; website research (HTTP + schema.org extractor, robots, SSRF guard, MOCK research); model adapters (MOCK, Ollama, Gemini) and the MX resolver (see `packages/providers/README.md`).
- `apps/admin/src/lib/rbac.ts`: `can`, `canAssignRole`, `isAdminRole`. Phase 6 permissions: `crm:read` (viewer+), `crm:write` (operator+), `crm:reopen`, `crm:dnc_clear`, `crm:import`, `crm:export` (admin, owner).
- `@kalpix/core` `crm.ts`: stage-transition rules, follow-up / health, note edit window, tags, promotion planning (tiers, round-robin, primary contact from facts), CSV parsing and import validation with dedupe keys, list filter parsing. `@kalpix/worker/crm-promote`: `promoteQualifiedLeads` (shared with the admin API).
- `apps/admin/src/server/crm.ts`: CRM service (RBAC, zod, optimistic concurrency, audit); `src/lib/crm-filters.ts`: list/export where-clause.
- `apps/admin/src/lib/provider-registry.ts`: default catalogue, `secretStatus` (names only).

## Scripts

`pnpm doctor`, `pnpm db:check`, `pnpm db:backup`, `pnpm db:deploy`, `pnpm db:seed`, `pnpm dev`, `pnpm build`, `pnpm start`, `pnpm e2e` (smoke, MFA, discovery, research, qualification, CRM), `pnpm worker`, `pnpm worker:once`.
