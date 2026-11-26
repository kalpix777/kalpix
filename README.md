<p align="center"><img src="docs/brand/kalpix-logo-light.png" alt="Kalpix" width="420"></p>

# Kalpix Platform

AI-powered website agency and business automation platform. Discovers local businesses, researches their real online presence, builds personalised website demos, and manages outreach, quotations, payments, delivery and maintenance with human approval at every external step.

Pilot market: Belagavi, Karnataka. Built to expand across India and internationally.

## Status

- **Phase 1** (environment and foundation): built and tested; local checks on the owner's machine still open.
- **Phase 2** (core app, database, admin dashboard): approved.
- **Phase 3** (business discovery: OSM Overpass/Nominatim, worker queue, Discovery and Businesses pages, CSV export): approved.
- **Phase 4** (business research: robots-aware HTTP + schema.org extractor, facts with provenance, conflict detection, Business Research page and research on business pages): built and tested with the MOCK providers; live website research not yet verified; awaiting owner approval.
- Phase 5 has not started.

## Quick start (local)

```bash
nvm use                       # Node 22 LTS (see .nvmrc)
corepack enable               # provides pnpm
pnpm install
cp .env.example .env          # then change POSTGRES_PASSWORD and DATABASE_URL
pnpm doctor                   # inspects this machine, writes reports/environment-report.md
pnpm db:up                    # local PostgreSQL 16 in Docker (localhost only)
pnpm db:check                 # verifies the database connection
pnpm verify                   # typecheck + lint + format + tests
# then add SEED_OWNER_EMAIL / SEED_OWNER_PASSWORD to .env
pnpm db:deploy                # apply migrations
pnpm db:seed                  # providers (disabled), settings, DEMO packages, first owner
pnpm dev                      # admin at http://localhost:3000, sign in, then enable MFA
pnpm build && pnpm start      # production build; in another terminal: pnpm e2e
pnpm worker                   # discovery + research + qualification worker: polls the queues (WORKER_POLL_INTERVAL_MS)
pnpm worker:once              # drain the queue once and exit (CI, cron)
```

For offline testing run the app with `DISCOVERY_PROVIDER=mock RESEARCH_PROVIDER=mock QUALIFICATION_AI_PROVIDER=mock pnpm start` (MOCK data and MOCK model, refused in production); `pnpm -F @kalpix/admin e2e:research` / `e2e:qualification` run one e2e suite. Worker integration tests: `pnpm -F @kalpix/worker test:integration` (needs PostgreSQL).

### Discovery environment variables (Phase 3)

| Variable                  | Default                                   | Purpose                                                                 |
| ------------------------- | ----------------------------------------- | ----------------------------------------------------------------------- |
| `DISCOVERY_PROVIDER`      | `overpass`                                | `overpass`, `mock` (not in production) or `google_places` (stub)        |
| `OVERPASS_API_URL`        | `https://overpass-api.de/api/interpreter` | Overpass endpoint (point at your own instance for heavy use)            |
| `NOMINATIM_BASE_URL`      | `https://nominatim.openstreetmap.org`     | Geocoder for place names                                                |
| `NOMINATIM_CONTACT_EMAIL` | (empty)                                   | Required by the Nominatim usage policy; place names disabled without it |
| `NOMINATIM_COUNTRY_CODES` | `in`                                      | Limits geocoding to these countries                                     |
| `DISCOVERY_MAX_BBOX_DEG2` | `0.25`                                    | Largest search box in square degrees                                    |
| `WORKER_POLL_INTERVAL_MS` | `5000`                                    | Worker poll interval (min 1000)                                         |
| `GOOGLE_PLACES_API_KEY`   | (empty)                                   | Paid; stays disabled until approved                                     |

Overpass and Nominatim must also be enabled and marked commercial-use verified by the owner in AI Provider Settings.

### Research environment variables (Phase 4)

| Variable                      | Default | Purpose                                                                                 |
| ----------------------------- | ------- | --------------------------------------------------------------------------------------- |
| `RESEARCH_PROVIDER`           | `http`  | `http` (robots-aware HTTP + schema.org extractor) or `mock` (not in production)         |
| `RESEARCH_MAX_PAGES`          | `5`     | Pages per website: homepage + likely contact/about pages (1-20)                         |
| `RESEARCH_HOST_DELAY_MS`      | `2000`  | Minimum delay between requests to one host (min 2000); a larger robots Crawl-delay wins |
| `RESEARCH_USER_AGENT_CONTACT` | (empty) | Email or URL in the KalpixBot User-Agent; required before real runs and in production   |

The HTTP extractor (`http-extractor`) is seeded disabled: the owner enables it in AI Provider Settings. Run a single worker (rate limits and the robots cache are in-process). Sites that render only with JavaScript yield few facts.

### Verification and qualification environment variables (Phase 5)

| Variable                       | Default            | Purpose                                                                                       |
| ------------------------------ | ------------------ | --------------------------------------------------------------------------------------------- |
| `QUALIFICATION_AI_PROVIDER`    | `none`             | `none` (rules only), `mock` (not in production), `ollama` or `gemini`; AI never changes score |
| `QUALIFICATION_PROMPT_VERSION` | `qual-v1`          | Stored with every AI result                                                                   |
| `VERIFICATION_DNS_TIMEOUT_MS`  | `3000`             | MX lookup timeout for email verification (200-30000)                                          |
| `OLLAMA_BASE_URL`              | (empty)            | Local Ollama server; required when the AI provider is `ollama`                                |
| `OLLAMA_MODEL`                 | `llama3.2:3b`      | Ollama model; check its licence                                                               |
| `GEMINI_API_KEY`               | (empty)            | Server-only; required when the AI provider is `gemini`. Free tier: Google may use prompts     |
| `GEMINI_MODEL`                 | `gemini-2.5-flash` | Gemini model                                                                                  |

Ollama and Gemini must also be enabled and have their commercial terms confirmed by the owner in AI Provider Settings; an explicitly chosen provider that is not ready is refused (409). Phone numbers and emails are masked before any AI call.

### CRM environment variables (Phase 6)

| Variable            | Default    | Purpose                                                                                            |
| ------------------- | ---------- | -------------------------------------------------------------------------------------------------- |
| `CRM_STALE_DAYS`    | `14`       | An open lead with no activity for this many days is shown as stale (1-365)                         |
| `CRM_PROMOTE_TIERS` | `hot,warm` | Qualification tiers promoted to CRM leads by default (`hot`, `warm`, `cold`; never `disqualified`) |

The CRM (`/crm`) never sends messages: WhatsApp and email arrive in Phases 11-12. Do-not-contact is recorded on the business and blocks outreach stages and export of its phone and email. `pnpm -F @kalpix/admin e2e:crm` runs the CRM e2e suite.

## Repository layout

```
apps/admin        Next.js admin dashboard: auth, RBAC, MFA, audit, providers, pricing
apps/worker       background worker: discovery and research queues (pnpm worker / worker:once)
packages/config   validated environment config (zod), secret-safe status
packages/core     provider contracts, Result type, enable rules
packages/providers  discovery adapters (OSM Overpass, Nominatim, MOCK, Google Places stub) and website research (HTTP extractor, MOCK)
infra/docker      local dev services
infra/backup      database backup script
scripts           doctor (environment inspection), check-db
docs              all project documentation and brand assets
```

## Documentation

See `docs/`: business requirements, roadmap, architecture, stack, free vs paid tools, schema, API, security, deployment, cost, testing and phase reports.
