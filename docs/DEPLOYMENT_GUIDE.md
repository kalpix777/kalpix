# Deployment Guide

## Local development (Phase 1)

1. Install Node 22 LTS (nvm or nvm-windows), Git, Docker Desktop.
2. `corepack enable && pnpm install`
3. `cp .env.example .env`; set a strong POSTGRES_PASSWORD and matching DATABASE_URL.
4. `pnpm doctor` then `pnpm db:up` then `pnpm db:check` then `pnpm verify`.
5. Push to a **private** GitHub repo; enable branch protection on `main` requiring the `ci` check.

## Windows notes

Use WSL2 backend for Docker Desktop. Run `pnpm db:backup` from Git Bash or WSL.

## Previews (Phase 10)

Cloudflare Pages for static demo sites, subject to commercial-terms check.

## Production (Phase 14-15)

VPS (Hetzner/DigitalOcean) with Docker, reverse proxy with TLS, managed or self-hosted Postgres with off-site backups, object storage, CDN, monitoring. Documented when built.
