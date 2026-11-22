# Testing Strategy

## Now (Phase 1)

- Unit tests with Vitest per package (`pnpm test`).
- Type safety with `tsc` strict mode (`pnpm typecheck`).
- ESLint and Prettier (`pnpm lint`, `pnpm format:check`).
- Environment verification (`pnpm doctor`, `pnpm db:check`).
- CI runs all of the above against a throwaway Postgres on every push and PR.

## Phase 2 additions

- Unit: RBAC matrix and role assignment, provider registry integrity, secret status never leaking values.
- E2E smoke (`apps/admin/e2e/smoke.mjs`, 29 checks): anonymous redirect, sign-up disabled, wrong password, owner access to all pages, 404 for unknown modules, viewer denied on 5 admin pages, suspended user blocked, sign-ins audited, audit log rejects UPDATE/DELETE, security headers.
- E2E MFA (`apps/admin/e2e/mfa.mjs`, 6 checks): enable, verify, second factor required, wrong code rejected, right code signs in.
- CI applies migrations, seeds, builds, starts the server and runs both suites.

## Later

- Integration tests against a real test database (Phase 2+).
- Provider contract tests with recorded fixtures; no fake integrations in production paths.
- Playwright end-to-end tests for the dashboard (Phase 2+).
- Generated-site QA: broken links, responsiveness, missing images, forms, navigation, SEO metadata, Lighthouse and axe accessibility (Phase 9).
- Webhook signature tests for Razorpay and WhatsApp (Phases 11, 13).
