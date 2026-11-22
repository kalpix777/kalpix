# Deployment Guide

## Local development (Phase 1)

1. Install Node 22 LTS (nvm or nvm-windows), Git, Docker Desktop.
2. `corepack enable && pnpm install`
3. `cp .env.example .env`; set a strong POSTGRES_PASSWORD and matching DATABASE_URL.
4. `pnpm doctor` then `pnpm db:up` then `pnpm db:check` then `pnpm verify`.
5. Push to a **private** GitHub repo; enable branch protection on `main` requiring the `ci` check.

## Admin app (Phase 2)

1. Add `AUTH_SECRET` (`openssl rand -base64 32`), `SEED_OWNER_EMAIL`, `SEED_OWNER_PASSWORD` to `.env`.
2. `pnpm db:deploy && pnpm db:seed`, then delete the seed password from `.env`.
3. `pnpm dev`, sign in at http://localhost:3000, open Account security and turn on two-factor.

## Windows notes

Use WSL2 backend for Docker Desktop. Run `pnpm db:backup` from Git Bash or WSL.

## Previews (Phase 10)

Cloudflare Pages for static demo sites, subject to commercial-terms check.

## Production (Phase 14-15)

VPS (Hetzner/DigitalOcean) with Docker, reverse proxy with TLS, managed or self-hosted Postgres with off-site backups, object storage, CDN, monitoring. Documented when built.
