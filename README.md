<p align="center"><img src="docs/brand/kalpix-logo-light.png" alt="Kalpix" width="420"></p>

# Kalpix Platform

AI-powered website agency and business automation platform. Discovers local businesses, researches their real online presence, builds personalised website demos, and manages outreach, quotations, payments, delivery and maintenance with human approval at every external step.

Pilot market: Belagavi, Karnataka. Built to expand across India and internationally.

## Status

**Phase 1 (environment and foundation): built, awaiting local verification and owner approval.** Phase 2 has not started.

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
```

## Repository layout

```
apps/admin        Next.js admin dashboard (Phase 2)
apps/worker       background jobs (Phase 3+)
packages/config   validated environment config (zod), secret-safe status
packages/core     provider contracts, Result type, enable rules
packages/providers  adapters: OSM, Ollama, Gemini, Resend, Razorpay... (Phase 3+)
infra/docker      local dev services
infra/backup      database backup script
scripts           doctor (environment inspection), check-db
docs              all project documentation and brand assets
```

## Documentation

See `docs/`: business requirements, roadmap, architecture, stack, free vs paid tools, schema, API, security, deployment, cost, testing and phase reports.
