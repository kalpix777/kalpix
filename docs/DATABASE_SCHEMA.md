# Database Schema

Phase 1 provisions PostgreSQL only; no tables exist yet. Prisma schema arrives in Phase 2.

## Planned core entities

- Users, Roles, Sessions, AuditLog (Phase 2)
- ProviderConfig, UsageEvent, CostEntry (Phase 2-5)
- Business, BusinessLocation, BusinessContact (Phase 3)
- ResearchRun, ResearchFact (source_url, collected_at, source_type, confidence, verification_status, usage_restrictions), MediaAsset (licence) (Phase 4)
- LeadScore, Qualification (Phase 5)
- Lead, Activity, Task, ApprovalRequest (Phase 6)
- WebsitePlan, Template, GeneratedSite, SiteVersion, QaReport, Deployment (Phase 7-10)
- Message, MessageTemplate, ConsentRecord, Enquiry (Phase 11-12)
- ServicePackage, PriceSetting, Quotation, Order, Payment, Invoice, Refund (Phase 13)
- CustomerSite, Subscription, MaintenanceTicket (Phase 14)

Conventions: UUID keys, created_at/updated_at, soft delete for business records, tenant_id once customer accounts exist, money as integer minor units plus currency.
