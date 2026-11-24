# @kalpix/worker

Background worker for Kalpix. Processes two queues stored in PostgreSQL with the same claim mechanism: business discovery (`discovery_run`, Phase 3) and website research (`research_run`, Phase 4). No Redis or external queue. Each poll drains discovery, then research.

## Commands (from the repo root)

```bash
pnpm worker                                   # poll forever (WORKER_POLL_INTERVAL_MS, default 5000, min 1000)
pnpm worker:once                              # drain the queue once and exit (CI, cron, e2e)
pnpm -F @kalpix/worker test                   # unit tests
pnpm -F @kalpix/worker test:integration       # against real PostgreSQL (DATABASE_URL from ../../.env)
```

Both read `../../.env` via `dotenv-cli`. `SIGINT`/`SIGTERM` finish the current run, then exit.

## How a run is processed

1. **Claim**: the oldest `queued` run, or a `running` run whose lock is older than 10 minutes (crashed worker), is taken with `FOR UPDATE SKIP LOCKED`, so several workers never share a run. `attempts` is incremented; a run claimed more than 5 times is failed.
2. **Readiness**: the provider must be enabled and commercial-use verified in AI Provider Settings (MOCK is allowed outside production only). A disabled real provider fails the run without any request.
3. **Area**: a bounding box is used as typed; a place name is geocoded with Nominatim through the PostgreSQL `geocode_cache` and stored on the run, so a resumed run never geocodes twice.
4. **Categories**: one at a time. Results are normalised, de-duplicated (provider id, then fuzzy name + distance) and upserted on `(provider, providerId)`; counts and `completedCategories` are saved after each category, so a crash resumes where it stopped and re-processing creates no duplicates.
5. **Finish**: `succeeded`, or `failed` with the error and completed progress kept (retry from the Discovery page). Provider requests are recorded as `usage_event` rows.

## How a research run is processed (Phase 4)

1. **Queue**: `enqueueResearchRun()` (`src/research-run.ts`) validates the scope (`businesses` ids, all businesses of a `discovery_run`, or a `filter` on category/city/status/hasWebsite/staleAfterDays/limit; max 500 businesses) and returns the existing run for a repeated `idempotencyKey`.
2. **Claim and readiness**: as for discovery (`FOR UPDATE SKIP LOCKED`, stale lock after 10 minutes, max 5 attempts). `http-extractor` must be enabled in AI Provider Settings; MOCK only outside production.
3. **Scope**: resolved once and stored in `targetIds`, so a resumed run researches the same set.
4. **Per business**: the monthly unit limit is checked, the website is researched (outside the transaction), then one transaction writes listing facts + website facts (upsert on the unique key), re-evaluates conflicts, writes the `business_research` row, a `usage_event` (units = HTTP requests, cost 0) and the run counters. A crash resumes after the last committed business; a provider error on one business is recorded (`status = error`) and the run continues.
5. **Finish**: `succeeded`, or `failed` with the error (disabled provider, monthly limit) and progress kept.

## Environment

`DATABASE_URL`, `DISCOVERY_PROVIDER`, `RESEARCH_PROVIDER`, `RESEARCH_MAX_PAGES`, `RESEARCH_HOST_DELAY_MS`, `RESEARCH_USER_AGENT_CONTACT`, `OVERPASS_API_URL`, `NOMINATIM_BASE_URL`, `NOMINATIM_CONTACT_EMAIL`, `NOMINATIM_COUNTRY_CODES`, `WORKER_POLL_INTERVAL_MS`. See the root `README.md` and `.env.example`.
