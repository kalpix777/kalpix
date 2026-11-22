# API Documentation

No HTTP API exists in Phase 1.

## Internal modules available now

- `@kalpix/config`: `loadEnv(source?)` validates environment and throws a readable error; `integrationStatus(env)` returns configured/missing per integration without values.
- `@kalpix/core`: `Provider`, `ProviderDescriptor`, `ProviderHealth`, `Result`, `ok`, `fail`, `canEnable(descriptor, configuredSecrets)`.

## CLI scripts

- `pnpm doctor`: read-only environment inspection, writes `reports/environment-report.md`, exits 1 on blocking issues.
- `pnpm db:check`: connects to `DATABASE_URL`, prints server version, exits 1 on failure.
- `pnpm db:backup`: gzip dump into `backups/`, keeps 14.

API routes, Zod request schemas and webhook endpoints will be documented here from Phase 2.
