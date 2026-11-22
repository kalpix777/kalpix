# Security Policy

## Secrets

- Never in Git or frontend code. `.env*` ignored except `.env.example`.
- Loaded and validated server-side; status reports show configured/missing only.
- Production: a secrets manager or encrypted server environment; rotate on staff change or suspected leak.

## Environments

- development, staging, production use separate databases and keys.
- Production startup refuses short AUTH_SECRET, default DB passwords and Razorpay test keys.

## Database

- Local Postgres bound to 127.0.0.1. Production DB never publicly exposed; TLS required; daily automated backups with tested restore.

## Access (implemented in Phase 2)

- Roles: owner, admin, operator, viewer. Matrix in `apps/admin/src/lib/rbac.ts`, enforced on every page and server action, not only hidden in the menu.
- Public sign-up disabled. Passwords 12+ characters, scrypt-hashed by Better Auth.
- TOTP MFA with backup codes. Owners and admins without MFA see a banner in development and are forced to Account security in production (`REQUIRE_ADMIN_MFA`).
- Sessions expire after 7 days, rolling daily. Suspension revokes all sessions.
- Auth rate limiting.
- Audit log covers sign-ins, user, role, provider, settings and pricing changes; append-only at database level.
- Owner-only: create owners, confirm provider commercial terms, activate paid providers, switch off approval rules.
- Headers: X-Frame-Options DENY, nosniff, strict referrer, restrictive permissions policy, no X-Powered-By; admin is noindex.
- Planned: tenant isolation with customer accounts (Phase 14).

## AI agent limits

No production data deletion, financial commitments, unapproved messages, customer site changes, credential exposure or cross-customer access without explicit human approval.

## Compliance

Indian DPDP Act 2023, IT Act 2000 and rules, GST invoicing, Consumer Protection (E-Commerce) Rules, TRAI/WhatsApp messaging and opt-in rules; GDPR and others where we operate. Legal review before launch.

## Reporting

Security issues go to the owner privately; never in public issues.
