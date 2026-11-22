# Database Schema

PostgreSQL 16, Prisma 6. Schema: `apps/admin/prisma/schema.prisma`. Migrations: `apps/admin/prisma/migrations`.

## Authentication tables (Better Auth 1.7: core, twoFactor, admin plugins)

| Table        | Purpose                      | Key fields                                                                   |
| ------------ | ---------------------------- | ---------------------------------------------------------------------------- |
| user         | Team members                 | email (unique), role (owner/admin/operator/viewer), twoFactorEnabled, banned |
| session      | Active sessions              | token (unique), expiresAt, ipAddress, userAgent                              |
| account      | Credentials                  | providerId, password (scrypt hash)                                           |
| verification | One-time tokens              | identifier, value, expiresAt                                                 |
| twoFactor    | TOTP secret and backup codes | secret, backupCodes, lockedUntil                                             |

## Platform tables

| Table           | Purpose                                               | Key fields                                                                                                                                  |
| --------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| audit_log       | Append-only record of sign-ins and privileged changes | actorId, actorLabel, action, entityType, entityId, ipAddress, metadata                                                                      |
| provider_config | One row per external provider                         | category, costTier, enabled, commercialUseVerified, requiredSecrets (names only), fallbackProviderId, monthlyLimitUnits, monthlyBudgetMinor |
| usage_event     | Usage and cost per provider call                      | providerId, operation, units, costMinor, isEstimate                                                                                         |
| system_setting  | Key/value JSON settings                               | key `general`: agency profile + approval rules                                                                                              |
| service_package | Configurable pricing                                  | code, category, billingCycle, priceMinor, currency, taxRateBps, active, isDemo                                                              |

## Database-level guarantees

- `audit_log` rejects UPDATE and DELETE via triggers (migration `audit_append_only`). Users are therefore suspended, never hard-deleted.
- Money is stored as integer minor units plus ISO currency.
- Secrets are never stored: only environment variable names.

## Planned (later phases)

Business, BusinessLocation, BusinessContact (3); ResearchRun, ResearchFact with source/date/confidence/verification, MediaAsset with licence (4); LeadScore (5); Lead, Activity, Task, ApprovalRequest (6); WebsitePlan, Template, GeneratedSite, SiteVersion, QaReport, Deployment (7-10); Message, MessageTemplate, ConsentRecord, Enquiry (11-12); Quotation, Order, Payment, Invoice, Refund (13); CustomerSite, Subscription, MaintenanceTicket (14). tenant_id arrives with customer accounts.
