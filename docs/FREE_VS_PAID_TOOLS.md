# Free vs Paid Tools

Commercial-use terms must be confirmed before any tool goes live. "Free" below means a free tier or open-source licence exists, not that commercial use is automatically permitted.

| Need               | Free-first                                         | Paid upgrade                        | Notes to verify                                                                                          |
| ------------------ | -------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Discovery          | OSM Overpass, Nominatim                            | Google Places API                   | Nominatim: max 1 req/s, identify app, no bulk geocoding; OSM data is ODbL (attribution)                  |
| Extraction         | HTTP + schema.org, Crawl4AI (self-hosted)          | Firecrawl                           | robots.txt and site terms                                                                                |
| AI                 | Ollama (local, hardware-limited), Gemini free tier | Gemini, OpenAI, Claude paid APIs    | Free tiers may use data for training and have low limits; consumer chat subscriptions are not API access |
| Automation         | Internal queue, n8n Community Edition              | n8n Cloud                           | n8n Sustainable Use Licence restricts offering it to customers as a service                              |
| Email              | Resend free tier                                   | Resend paid, Brevo                  | Domain verification, sending limits                                                                      |
| WhatsApp           | none (per-conversation charges apply)              | Meta Cloud API / BSP                | Opt-in, approved templates                                                                               |
| Payments           | Razorpay test mode                                 | Razorpay live (per-transaction fee) | KYC required for live                                                                                    |
| Previews           | Cloudflare Pages free                              | Cloudflare paid / VPS               | Confirm commercial terms before customer sites                                                           |
| Production hosting | none                                               | Hetzner / DigitalOcean VPS          |                                                                                                          |
| Database           | Local PostgreSQL                                   | Neon / Supabase / managed PG        |                                                                                                          |
| Monitoring         | Umami, logs, Grafana                               | PostHog, Sentry                     |                                                                                                          |
| Containers         | Docker Engine (Linux)                              | Docker Desktop paid seats           | Docker Desktop is free for companies under 250 staff and under USD 10M revenue                           |

Before switching any module to paid: why free is insufficient, what paid improves, estimated cost, expected benefit, alternatives. No activation without owner approval.

## Discovery providers (Phase 3)

| Provider                              | Cost tier | State in Phase 3                                    | Usage policy / licence                                                                                                                                                                        |
| ------------------------------------- | --------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OSM Overpass API                      | Free      | Built; default (`DISCOVERY_PROVIDER=overpass`)      | Public servers are shared: modest query size (box capped by `DISCOVERY_MAX_BBOX_DEG2`), >= 2 s between queries, identifying User-Agent, back off on 429/504. Heavy use: run your own instance |
| Nominatim (OSM geocoding)             | Free      | Built; place names only, results cached in database | Max 1 request/second, identifying User-Agent with contact (`NOMINATIM_CONTACT_EMAIL`), cache results, no bulk or systematic geocoding, attribution                                            |
| OpenStreetMap data                    | Free      | Stored with source, URL and licence on every record | ODbL 1.0: attribution "© OpenStreetMap contributors"; share-alike applies to a derived database made public                                                                                   |
| MOCK provider                         | Free      | Built; tests/CI only, refused in production         | Fake data, every record named "MOCK …"                                                                                                                                                        |
| Google Places API                     | Paid      | Stub only, disabled, never called                   | Per-request billing; Places content has storage/caching and display restrictions. Needs key, budget and owner approval                                                                        |
| Geofabrik / openstreetmap.fr extracts | Free      | Not implemented (offline fallback option)           | Geofabrik "India – Southern Zone" or openstreetmap.fr Karnataka `.osm.pbf` could be imported if public Overpass is unreachable or rate-limited; ODbL still applies                            |

Commercial-use terms for each OSM service have **not** been confirmed yet; the owner marks each provider "commercial use verified" in AI Provider Settings before it can be enabled. Phase 3 cost so far: Rs 0.
