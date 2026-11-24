# Database Schema

PostgreSQL 16+ (CI and build environment also run 17), Prisma 6. Schema: `apps/admin/prisma/schema.prisma`. Migrations: `apps/admin/prisma/migrations`.

## Authentication tables (Better Auth 1.7: core, twoFactor, admin plugins)

| Table        | Purpose                      | Key fields                                                                   |
| ------------ | ---------------------------- | ---------------------------------------------------------------------------- |
| user         | Team members                 | email (unique), role (owner/admin/operator/viewer), twoFactorEnabled, banned |
| session      | Active sessions              | token (unique), expiresAt, ipAddress, userAgent                              |
| account      | Credentials                  | providerId, password (scrypt hash)                                           |
| verification | One-time tokens              | identifier, value, expiresAt                                                 |
| twoFactor    | TOTP secret and backup codes | secret, backupCodes, lockedUntil                                             |

## Platform tables

| Table           | Purpose                                               | Key fields                                                                                                                                  |
| --------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| audit_log       | Append-only record of sign-ins and privileged changes | actorId, actorLabel, action, entityType, entityId, ipAddress, metadata                                                                      |
| provider_config | One row per external provider                         | category, costTier, enabled, commercialUseVerified, requiredSecrets (names only), fallbackProviderId, monthlyLimitUnits, monthlyBudgetMinor |
| usage_event     | Usage and cost per provider call                      | providerId, operation, units, costMinor, isEstimate                                                                                         |
| system_setting  | Key/value JSON settings                               | key `general`: agency profile + approval rules                                                                                              |
| service_package | Configurable pricing                                  | code, category, billingCycle, priceMinor, currency, taxRateBps, active, isDemo                                                              |

## Discovery tables (Phase 3, migration `20261123000000_phase3_discovery`)

| Table         | Model        | Purpose                                                  | Key fields                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------- | ------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| discovery_run | DiscoveryRun | One discovery job; also the worker's queue               | area, categories[], provider, status (queued/running/succeeded/failed/cancelled), idempotencyKey (unique), resolved bbox + areaDisplayName, completedCategories[], found/created/updated/duplicate/skipped/request counts, attempts, error, lockedBy/lockedAt, startedById/startedByLabel                                                                                                              |
| business      | Business     | A discovered business with provenance                    | name, normalizedName, category, subcategory, provider + providerId (unique together), osmType/osmId, alternateIds[], address parts, lat/lon, phone, website, hasWebsite, email, openingHours, source, sourceType, sourceUrl, collectedAt, lastSeenAt, confidence, verificationStatus, license, usageRestrictions, rawTags, firstRunId/lastRunId, status (NEW/REVIEWED/QUALIFIED/DISQUALIFIED/ARCHIVED) |
| geocode_cache | GeocodeCache | Nominatim results shared across processes (usage policy) | key (normalised query), query, provider, displayName, south/west/north/east, sourceUrl, fetchedAt                                                                                                                                                                                                                                                                                                      |

- Indexes: `discovery_run(status, createdAt)`, `discovery_run(createdAt)`; `business(category)`, `(hasWebsite)`, `(status)`, `(lat, lon)`, `(createdAt)`.
- The worker claims runs with `FOR UPDATE SKIP LOCKED`; a stale `running` lock is reclaimed. Upserts on `(provider, providerId)` make re-processing idempotent; fuzzy duplicates (same category, < 50 m, name similarity >= 0.85) are merged and recorded in `alternateIds`.
- `confidence` is a completeness heuristic (0..1), not a verification. MOCK rows have `source = "mock"`, provider `mock-discovery` and names starting with `MOCK`.

## Research tables (Phase 4, migration `20261124000000_phase4_research`)

| Table             | Model            | Purpose                                                        | Key fields                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------- | ---------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| research_run      | ResearchRun      | One website-research job; also the worker's queue (job type 2) | provider (`http-extractor` / `mock-research`), status, idempotencyKey (unique), scopeType (businesses / discovery_run / filter), businessIds[], discoveryRunId, filter (JSON), targetIds[] + resolvedAt (scope frozen at start), total/processed/ok/noWebsite/broken/blocked/error/fact/newFact/conflict/request counts, attempts, error, errors (JSON, last 50), lockedBy/lockedAt, startedById/startedByLabel |
| business_research | BusinessResearch | Outcome of one business in one run (unique runId + businessId) | status (ok / no_website / broken / blocked / error), httpStatus, requestedUrl, finalUrl, signals (JSON `WebsiteSignals`), summary (plain language, no score), factCount, conflictFields[], requestCount, error, researchedAt                                                                                                                                                                                    |
| research_fact     | ResearchFact     | One value about a business with provenance                     | field, value, normalizedValue, sourceUrl, sourceType (jsonld / microdata / meta / html / header / robots / osm / listing / mock), provider, collectedAt, confidence, verificationStatus (unverified / verified / conflicting), usageRestriction, firstRunId/lastRunId                                                                                                                                           |

- `business.lastResearchedAt` is new (set after every research of that business).
- `research_fact` is unique on `(businessId, field, normalizedValue, sourceUrl)`: re-research refreshes `collectedAt`/`lastRunId`, never duplicates. CHECK constraints cap `value` 1000, `normalizedValue` 400 and `sourceUrl` 500 characters (keeps the unique index within B-tree limits), keep `confidence` in 0..1 and `verificationStatus` / `scopeType` to their allowed values.
- **Listing values are facts too.** At research time the discovery record's phone(s), email, website (or social profile), WhatsApp, opening hours, postcode, address, geo and name are written as facts with `sourceType = osm` (OpenStreetMap) or `listing` (other discovery providers), the record's `sourceUrl`, `collectedAt`, `confidence` and licence text. Every value therefore has one provenance shape; the `business` columns stay as discovered and are not overwritten by website data.
- **Conflict rule** (`detectConflicts` in `packages/core/src/research.ts`): for phone, email, whatsapp, postcode and opening_hours, facts are `conflicting` when the listing (osm/listing) and the website (everything else) both have values and share none. One shared value means agreement; several website values never conflict with each other. It is re-evaluated over all stored facts of the business after each research and only moves facts between `unverified` and `conflicting`; `verified` is reserved for Phase 5.
- `confidence` on website facts is extraction-method reliability (JSON-LD 0.8, microdata 0.75, tel:/mailto:/social links 0.7, meta 0.6, free text 0.5), not verification.
- Deleting a business cascades its facts and research rows; deleting a run cascades its `business_research` rows (facts keep `firstRunId`/`lastRunId` as plain ids).

## Database-level guarantees

- `audit_log` rejects UPDATE and DELETE via triggers (migration `audit_append_only`). Users are therefore suspended, never hard-deleted.
- Money is stored as integer minor units plus ISO currency.
- Secrets are never stored: only environment variable names.

## Planned (later phases)

MediaAsset with licence (later in 4, not built); LeadScore (5); Lead, Activity, Task, ApprovalRequest (6); WebsitePlan, Template, GeneratedSite, SiteVersion, QaReport, Deployment (7-10); Message, MessageTemplate, ConsentRecord, Enquiry (11-12); Quotation, Order, Payment, Invoice, Refund (13); CustomerSite, Subscription, MaintenanceTicket (14). tenant_id arrives with customer accounts.
