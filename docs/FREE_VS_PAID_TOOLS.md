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
