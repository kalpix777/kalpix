## Vercel + Neon (free preview hosting)

- Vercel project root directory: `apps/admin`. Vercel runs `vercel-build`: prisma generate, migrate deploy, idempotent seed, next build.
- Database: Neon Postgres added from Vercel Storage; it injects `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED` (used for migrations and seed).
- Required env vars in Vercel: `AUTH_SECRET`, `APP_ENV=production`, `SEED_OWNER_EMAIL`, `SEED_OWNER_PASSWORD`. Remove `SEED_OWNER_PASSWORD` after the first successful deploy.
- `APP_URL` falls back to `https://$VERCEL_PROJECT_PRODUCTION_URL`.
- Vercel Hobby is for non-commercial use. Move to a paid plan or a VPS before commercial use (owner approval needed).
