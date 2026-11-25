# Phase Completion Reports

## Phase 1: Environment and project setup

**Status: foundation built and tested in a clean Linux build environment. Local verification on the owner's machine and owner approval are still required.**

### Acceptance criteria

| Criterion                                                | Status                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Monorepo with Node 22 / pnpm / TypeScript strict         | PASS (build env)                                                               |
| Lint, format, typecheck, unit tests pass                 | PASS (8/8 tests)                                                               |
| Validated env strategy with production guards            | PASS (tests)                                                                   |
| Provider contract foundation with no fake integrations   | PASS (tests)                                                                   |
| Environment doctor runs read-only and writes report      | PASS (build env)                                                               |
| PostgreSQL reachable via `pnpm db:check`                 | PASS against real PostgreSQL in build env; pending on owner machine via Docker |
| Docker Compose Postgres starts and is healthy            | PENDING (owner machine)                                                        |
| Antigravity + REA MCP confirmed present, not reinstalled | PENDING (owner machine)                                                        |
| Private GitHub repo + CI green                           | PENDING (owner action)                                                         |
| All 13 documents created                                 | PASS                                                                           |

### Remaining manual actions

1. Unzip into your workspace folder, open in Antigravity.
2. Run `pnpm install`, `pnpm doctor` and share `reports/environment-report.md`.
3. Start Docker Desktop, then `pnpm db:up` and `pnpm db:check`.
4. Confirm the REA MCP server shows as connected in Antigravity's MCP settings.
5. Create a private GitHub repo, push, confirm CI passes.

## Phase 2: Core application, database and admin dashboard

**Status: built and tested in the build environment against a real PostgreSQL server. Awaiting owner review and approval. Phase 3 not started.**

### Delivered

- Next.js 15 admin (`apps/admin`), Tailwind 4, shadcn-compatible components, Lucide icons, Sora/Manrope brand type, mobile menu.
- All 24 navigation items. Working now: Overview, Sales (service packages), AI Provider Settings, Integrations, User Management, Audit Logs, System Settings, Account security. The rest show an honest "Not built yet, Phase N" state.
- Prisma schema, 2 migrations, idempotent seed (16 providers disabled, settings, 2 DEMO packages, first owner).
- Better Auth: email/password, TOTP MFA, admin plugin, rate limits, sign-up off.
- RBAC (4 roles), owner-only safeguards, approval rules, append-only audit log.

### Acceptance criteria

| Criterion                                           | Status       |
| --------------------------------------------------- | ------------ |
| Typecheck, lint, format                             | PASS         |
| Unit tests                                          | PASS (16/16) |
| Production build                                    | PASS         |
| Migrations on clean DB, idempotent seed             | PASS         |
| Sign-in/out, sign-up blocked, bad password rejected | PASS (e2e)   |
| TOTP MFA enable and enforce                         | PASS (e2e)   |
| RBAC on pages and actions                           | PASS (e2e)   |
| Audit logging and immutability                      | PASS (e2e)   |
| Keys shown as configured/missing only               | PASS         |
| Prices configurable, none hardcoded                 | PASS         |
| Runs on owner's machine with Docker Postgres        | PENDING      |
| CI green on GitHub                                  | PENDING      |

### Known limits

- MFA setup shows the key as text; QR code is a small follow-up.
- Integration health shows "Not checked" until each adapter ships.
- Usage/cost tables fill once real providers run (Phase 3+).
- Users are suspended, not deleted (audit immutability).

## Phase 3: Business discovery engine

**Status: built and tested in the build environment against a real PostgreSQL 17 server with the MOCK provider. Live OpenStreetMap data is unverified (see below). Approved by the owner.**

### Delivered

- `packages/providers`: OSM Overpass discovery adapter (category tag map in `config/category-tags.json`, fair-use rate limiter, retry with backoff and `Retry-After`), Nominatim geocoder (1 req/s, identifying User-Agent, contact email, country filter, cache), normaliser (address, phone, website, completeness confidence), duplicate detection (provider id + fuzzy name/distance), CSV writer, deterministic MOCK provider, Google Places stub (paid, disabled, never called).
- `apps/worker`: DB-backed queue (`FOR UPDATE SKIP LOCKED`), one category at a time with progress saved so a crashed run resumes, stale-lock recovery, idempotent upserts, PostgreSQL geocode cache. `pnpm worker` (poll) and `pnpm worker:once` (drain and exit).
- Admin: **Business Discovery** page (provider readiness, start run by place name or bounding box, run table with counts, retry/cancel, auto-refresh while active) and **Businesses** page (search and filters, MOCK labelling, provenance and confidence, CSV export for admin+).
- HTTP API: `GET/POST /api/discovery/runs`, `GET /api/businesses/export` (see API_DOCUMENTATION.md). Cookieless `/api/*` requests now get `401 {"error":"unauthorized"}` from the middleware; pages still redirect to `/login`.
- RBAC: `discovery:run` (operator+), `businesses:export` (admin+). Run start, retry, cancel and export are audited.
- Migration `20261123000000_phase3_discovery`: `discovery_run`, `business`, `geocode_cache`.

### Acceptance criteria

| Criterion                                              | Status                                      |
| ------------------------------------------------------ | ------------------------------------------- |
| Typecheck, lint, format                                | PASS                                        |
| Unit tests (`pnpm verify`)                             | PASS (74/74)                                |
| Worker integration tests (real PostgreSQL)             | PASS (6/6)                                  |
| Production build                                       | PASS                                        |
| E2E smoke / MFA / discovery (against `pnpm start`)     | PASS (29/29, 6/6, 30/30)                    |
| Overpass parsing and normalisation (recorded fixture)  | PASS (unit tests)                           |
| Idempotent run start and re-processing (no duplicates) | PASS (e2e + integration)                    |
| RBAC and audit on run/export                           | PASS (e2e)                                  |
| Live Overpass / Nominatim query from build environment | NOT VERIFIED (network, see below)           |
| Commercial-use terms confirmed for OSM services        | PENDING (owner)                             |
| Runs on owner's machine; CI green on GitHub            | PENDING / see CI run for the Phase 3 commit |

### Live data check

The live Overpass query could not be completed from the build sandbox: a plain `fetch` timed out at 40 s, and with `NODE_USE_ENV_PROXY=1` it failed with `fetch failed`. Live OSM data is therefore **unverified**; the adapter is tested only against a recorded Overpass fixture. All data visible in the screenshots and e2e runs comes from the MOCK provider and is labelled **MOCK** everywhere (name prefix, badge, source column, CSV).

### Known limits

- Google Places adapter is a disabled stub; it needs a key, a cost decision and owner-confirmed terms (Places has storage/caching restrictions).
- Overpass and Nominatim must be enabled and marked commercial-use verified by the owner in AI Provider Settings before real runs; Nominatim also needs `NOMINATIM_CONTACT_EMAIL`. Without Nominatim, only bounding boxes work.
- Offline fallback (not implemented): import a Geofabrik "India – Southern Zone" extract or the openstreetmap.fr Karnataka extract (`.osm.pbf`) if the public Overpass servers are unreachable or rate-limited.
- Confidence is a completeness heuristic, not a verification (verification is Phase 5).

### Cost

Rs 0. Overpass and Nominatim are free public services with usage policies; no paid API was called.

## Phase 4: Business research and extraction

**Status: approved by the owner. Built and tested in the build environment against a real PostgreSQL 17 server, in-process HTTP test sites and the MOCK providers. Live website research is unverified from the build sandbox (see below).**

### Delivered

- `packages/core/src/research.ts`: `WebsiteResearchProvider`, `ResearchFact` with provenance (sourceUrl, collectedAt, sourceType, confidence, verificationStatus, usageRestriction), `WebsiteSignals`, run scopes and `parseResearchFilter`, `detectConflicts`.
- `packages/providers/src/research/`: polite fetcher (KalpixBot User-Agent with contact, robots.txt per RFC 9309 with cache and Crawl-delay, per-host delay >= 2 s, 15 s timeout, 2 MB cap after decompression, <= 5 redirects re-checked each hop, <= 5 pages per site: homepage + same-site contact/about pages), SSRF guard (http/https and web ports only, no credentials, private/loopback/link-local/CGNAT/multicast/NAT64/6to4 blocked, checked again at DNS-connect time), cheerio extraction (JSON-LD incl. `@graph` and openingHoursSpecification, microdata, meta/og, tel:/mailto:, obfuscated emails, Indian phones to E.164, Facebook/Instagram/X/LinkedIn/YouTube, WhatsApp), quality signals and tech hints, broken-site classification, deterministic MOCK provider.
- Migration `20261124000000_phase4_research`: `research_run`, `business_research`, `research_fact`, `business.lastResearchedAt`.
- `apps/worker`: job type "research" (`research-run.ts`): scope resolution frozen on the run, per-business transaction, resumable, monthly limit checked before each business, `usage_event` per business at cost 0, discovery listing values stored as facts too, conflict refresh across all of a business's facts.
- Admin: **Business Research** page (provider readiness, start a run for a discovery run or a filter, run table with outcome counts, facts, conflicts, retry/cancel); research section on the business detail page (latest result, plain-language observations, every fact with source URL, source type, confidence, status and collection time, conflicting rows highlighted, "Research this business"); Research column and filter (never / researched / has conflicts) on the Businesses list, plus "Research these".
- HTTP API: `GET/POST /api/research/runs` (see API_DOCUMENTATION.md). RBAC: `research:run` (operator+). Run start, retry and cancel are audited (`research.run_start`, `research.run_retry`, `research.run_cancel`).
- E2E: `apps/admin/e2e/research.mjs` (`pnpm -F @kalpix/admin e2e:research`, part of `pnpm e2e`); CI sets `RESEARCH_PROVIDER=mock`.
- Env: `RESEARCH_PROVIDER`, `RESEARCH_MAX_PAGES`, `RESEARCH_HOST_DELAY_MS`, `RESEARCH_USER_AGENT_CONTACT`.

### Acceptance criteria

| Criterion                                                       | Status                                      |
| --------------------------------------------------------------- | ------------------------------------------- |
| Typecheck, lint, format                                         | PASS                                        |
| Unit tests (`pnpm verify`)                                      | PASS (137/137)                              |
| Worker integration tests (real PostgreSQL)                      | PASS (12/12: 6 discovery + 6 research)      |
| Production build                                                | PASS                                        |
| E2E smoke / MFA / discovery / research (against `pnpm start`)   | PASS (29/29, 6/6, 30/30, 33/33)             |
| Extraction from HTML fixtures (no network)                      | PASS                                        |
| robots.txt honoured, SSRF blocked (incl. redirect to 10/8)      | PASS (unit + integration)                   |
| Idempotent run start; re-research creates 0 duplicate facts     | PASS (e2e + integration)                    |
| Conflicting listing vs website values flagged and shown         | PASS (e2e)                                  |
| RBAC (anonymous 401, viewer 403, operator 202) and audit        | PASS (e2e)                                  |
| Resume after crash; monthly limit and disabled provider refused | PASS (integration)                          |
| Live website research from build environment                    | NOT VERIFIED (see below)                    |
| Runs on owner's machine; CI green on GitHub                     | PENDING / see CI run for the Phase 4 commit |

### Live data check

Live website research was not verified from the build sandbox (outbound requests are unreliable there, as with Overpass in Phase 3). The extractor is tested against recorded HTML fixtures and in-process HTTP test sites. All data in the screenshots and e2e runs comes from the MOCK providers and is labelled **MOCK** everywhere.

### Known limits

- No JavaScript rendering: sites built entirely client-side (some Wix/React sites) yield few or no facts. Crawl4AI could be a later fallback.
- The rate limiter and robots cache are in-process: run a single research worker (as with discovery).
- Image facts (logos, photos) are not extracted or stored in this phase.
- Free-text phone extraction is conservative (Indian numbers only); `confidence` is extraction reliability, not verification (verification is Phase 5).
- `http-extractor` is seeded disabled: the owner must enable it in AI Provider Settings and set `RESEARCH_USER_AGENT_CONTACT` (an email or URL; required when `APP_ENV=production`) before real runs.
- "Research these" from the Businesses list with the "never researched" filter is passed to the run as "not researched in 3650 days" (an approximation: never, or more than 10 years ago).

### Cost

Rs 0. No paid API; website fetches are recorded as `usage_event` with `costMinor = 0`.

## Phase 5: Verification and AI qualification

**Status: built and tested in the build environment against a real PostgreSQL 17 server, the MOCK discovery/research providers and the MOCK model. Ollama and Gemini were never called live. Awaiting owner review and approval. Phase 6 not started.**

### Delivered

- `packages/core/src/verification.ts`: automatic fact checks (phone format + independent-source agreement, email syntax + reserved/test/disposable domains + MX lookup, website reachability from research, Indian PIN format + state prefix, conflicts), statuses `verified / unverified / conflicting / invalid`, manual override statuses.
- `packages/core/src/qualification.ts`: transparent rules score (`rules-v1`, 0-100: website opportunity, contactability, category fit), tiers hot / warm / cold / disqualified (duplicate, closed, no usable contact), every reason linked to the facts it rests on. `packages/core/src/model.ts`: model contract.
- `packages/providers/src/model/`: MOCK, Ollama and Gemini adapters (prompt `qual-v1`, JSON output validated, token counts and cost recorded), MX resolver in `packages/providers/src/verification/`.
- Migration `20261125000000_phase5_qualification`: `qualification_run`, `business_qualification` (unique per run and business), verification/override columns on `research_fact`, `business.latestScore / latestTier / qualifiedAt`.
- `apps/worker`: job type "qualification" (`qualification-run.ts`, `verification-store.ts`): verify facts, score, tier, optional AI suggestion, per-business transaction, resumable.
- Admin: **Lead Qualification** page (`/leads`: AI readiness, start a run, run table with tier/fact/AI counts, ranked leads with top reason and contactability); business detail Qualification card (score, tier, component bars, reasons with fact links), **"AI suggestion — not verified"** card, per-fact verification status with override form (reason required) and remove-override; Businesses list Score and Tier columns, tier filter and score sort.
- HTTP API: `GET/POST /api/qualification/runs`; server actions for start/retry/cancel and fact override/clear (see API_DOCUMENTATION.md). RBAC: `qualification:run`, `facts:verify` (operator+). Audit: `qualification.run_start`, `qualification.run_retry`, `qualification.run_cancel`, `fact.verify_override`, `fact.verify_override_clear`.
- E2E: `apps/admin/e2e/qualification.mjs` (`pnpm -F @kalpix/admin e2e:qualification`, part of `pnpm e2e`); CI sets `QUALIFICATION_AI_PROVIDER=mock`.
- Env: `QUALIFICATION_AI_PROVIDER`, `QUALIFICATION_PROMPT_VERSION`, `VERIFICATION_DNS_TIMEOUT_MS`, `OLLAMA_MODEL`, `GEMINI_MODEL`.

### Acceptance criteria

| Criterion                                                                             | Status                                      |
| ------------------------------------------------------------------------------------- | ------------------------------------------- |
| Typecheck, lint, format                                                               | PASS                                        |
| Unit tests (`pnpm verify`)                                                            | PASS (228/228)                              |
| Worker integration tests (real PostgreSQL)                                            | PASS (20/20)                                |
| Production build                                                                      | PASS                                        |
| E2E smoke / MFA / discovery / research / qualification (`pnpm start`)                 | PASS (29/29, 6/6, 30/30, 33/33, 48/48)      |
| RBAC (anonymous 401, viewer 403 and no forms, operator 202), cross-origin 403         | PASS (e2e)                                  |
| Explicitly chosen AI provider that is not ready refused (409)                         | PASS (e2e)                                  |
| Idempotent run start; re-run creates no duplicate qualifications or facts             | PASS (e2e + integration)                    |
| Leads ranked by score; detail shows score, tier, reasons, MOCK AI card                | PASS (e2e, screenshots)                     |
| Manual override saved with reason, audited, kept by the automatic pass; clear audited | PASS (e2e)                                  |
| Live Ollama / Gemini calls                                                            | NOT VERIFIED (never called)                 |
| Runs on owner's machine; CI green on GitHub                                           | PENDING / see CI run for the Phase 5 commit |

### Safety and data handling

- AI is off by default (`QUALIFICATION_AI_PROVIDER=none`) and gated: a provider is used only when the owner has enabled it, confirmed its commercial terms and its key/URL is set; the worker re-checks before every call. MOCK is refused in production.
- AI never changes the score or tier: they come only from the rules. AI text is labelled "AI suggestion — not verified" and disqualified businesses are not sent to AI.
- Phone numbers and emails are masked in prompts.
- Gemini free tier: Google may use prompts and responses; the UI warns and recommends a paid (billing-enabled) project for customer data.

### Known limits

- Postcode verification checks the 6-digit format and the state prefix only, not that the PIN exists or matches the locality.
- Manual overrides apply to the score on the next qualification run, not immediately.
- A run resumed after a crash may repeat the AI call for the business that was in progress (one extra call, recorded).
- The disposable-email domain list is small and not exhaustive.
- An email is verified only with a mail-capable domain (MX) plus a second independent source or the business's own website domain; otherwise it stays unverified. City is not checked against the PIN (no offline PIN directory).

### Cost

Rs 0. Only the MOCK model was used; no paid API was called. AI token counts and cost are recorded per run (`aiCostMinor = 0` for MOCK).
