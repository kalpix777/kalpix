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

## Access (Phase 2+)

RBAC, MFA mandatory for administrators, session expiry, rate limits, audit log of every privileged and external action, tenant isolation for customer accounts.

## AI agent limits

No production data deletion, financial commitments, unapproved messages, customer site changes, credential exposure or cross-customer access without explicit human approval.

## Compliance

Indian DPDP Act 2023, IT Act 2000 and rules, GST invoicing, Consumer Protection (E-Commerce) Rules, TRAI/WhatsApp messaging and opt-in rules; GDPR and others where we operate. Legal review before launch.

## Reporting

Security issues go to the owner privately; never in public issues.
