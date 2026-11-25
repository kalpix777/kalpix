# Architecture

## Style

Modular monolith in a pnpm monorepo. Business logic lives in packages, independent of UI. Separate workers are introduced only when load justifies them.

```
            +-------------------- apps/admin (Next.js) --------------------+
            |  dashboard UI  ->  API routes / server actions                |
            +-------------------------------+-------------------------------+
                                            |
      +-------------------------------------v------------------------------------+
      | packages/core: domain services (discovery, research, verification,       |
      | qualification, CRM, planning, generation, QA, deploy, messaging,         |
      | quotation, payment, maintenance, analytics, audit)                       |
      +------+----------------------+-------------------------+-----------------+
             |                      |                         |
   packages/providers        PostgreSQL (Prisma)        apps/worker (jobs)
   (adapters behind
    Provider interfaces)
```

## Provider layer

Every external service implements `Provider` (`packages/core/src/provider.ts`): descriptor (category, cost tier, required secret names, commercial-use verified flag, fallback) and `healthCheck()`. `canEnable()` refuses providers with missing secrets or unverified commercial terms. Interfaces planned: BusinessDiscoveryProvider, WebsiteResearchProvider, ModelProvider, EmailProvider, WhatsAppProvider, PaymentProvider, HostingProvider, StorageProvider.

## Data provenance

Every researched fact is stored with source URL, collected-at, source type, confidence, verification status and usage restrictions (`research_fact`, Phase 4). Discovery-record values are stored as facts too (`sourceType` osm/listing), so listing and website values share one shape and disagreements are flagged `conflicting` (see DATABASE_SCHEMA.md).

## Job queue

`apps/worker` processes three job types from PostgreSQL tables with the same mechanism (claim with `FOR UPDATE SKIP LOCKED`, stale-lock recovery after 10 minutes, max 5 attempts, progress committed per unit so a crashed run resumes): `discovery_run` (one unit = one category), `research_run` (one unit = one business) and `qualification_run` (one unit = one business: verification, rules score, optional AI). No Redis.

## Human-in-the-loop

Outbound messages, financial actions and production changes pass through a configurable approval queue (Phase 6+), logged in the audit trail.

## Components (21)

Admin dashboard, discovery, business intelligence, website research, verification, AI qualification, CRM, website planning, generation, QA, demo deployment, WhatsApp, email, customer comms, enquiries, quotations, payments, production deployment, maintenance, analytics, security and audit.
