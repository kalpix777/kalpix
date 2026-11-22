# Testing Strategy

## Now (Phase 1)

- Unit tests with Vitest per package (`pnpm test`).
- Type safety with `tsc` strict mode (`pnpm typecheck`).
- ESLint and Prettier (`pnpm lint`, `pnpm format:check`).
- Environment verification (`pnpm doctor`, `pnpm db:check`).
- CI runs all of the above against a throwaway Postgres on every push and PR.

## Later

- Integration tests against a real test database (Phase 2+).
- Provider contract tests with recorded fixtures; no fake integrations in production paths.
- Playwright end-to-end tests for the dashboard (Phase 2+).
- Generated-site QA: broken links, responsiveness, missing images, forms, navigation, SEO metadata, Lighthouse and axe accessibility (Phase 9).
- Webhook signature tests for Razorpay and WhatsApp (Phases 11, 13).
