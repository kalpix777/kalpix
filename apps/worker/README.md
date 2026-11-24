# @kalpix/worker

Background worker for Kalpix. Phase 3: processes the business-discovery queue stored in PostgreSQL (`discovery_run` table). No Redis or external queue.

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

## Environment

`DATABASE_URL`, `DISCOVERY_PROVIDER`, `OVERPASS_API_URL`, `NOMINATIM_BASE_URL`, `NOMINATIM_CONTACT_EMAIL`, `NOMINATIM_COUNTRY_CODES`, `WORKER_POLL_INTERVAL_MS`. See the root `README.md` and `.env.example`.
