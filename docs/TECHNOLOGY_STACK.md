# Technology Stack

| Layer           | Choice                                                                  | Phase |
| --------------- | ----------------------------------------------------------------------- | ----- |
| IDE             | Antigravity (existing REA MCP, not reinstalled); VS Code as alternative | 1     |
| Runtime         | Node.js 22 LTS, TypeScript 5                                            | 1     |
| Package manager | pnpm (Corepack) workspaces                                              | 1     |
| Quality         | ESLint 9 (flat config), Prettier, Vitest                                | 1     |
| Config          | zod-validated env                                                       | 1     |
| Database        | PostgreSQL 16 (Docker locally)                                          | 1     |
| ORM             | Prisma                                                                  | 2     |
| Frontend        | Next.js, React, Tailwind CSS, shadcn/ui, Lucide                         | 2     |
| Auth            | Better Auth (RBAC, MFA)                                                 | 2     |
| Discovery       | OSM Overpass, Nominatim; Google Places (paid)                           | 3     |
| Research        | HTTP + schema.org/sitemap, Crawl4AI; Firecrawl (paid)                   | 4     |
| AI              | Ollama if hardware allows; Gemini/OpenAI/Claude APIs                    | 5     |
| Automation      | Internal job queue; n8n CE (licence review first)                       | 6+    |
| Images          | Sharp                                                                   | 8     |
| Testing         | Playwright, Lighthouse, axe                                             | 9     |
| Hosting         | Cloudflare Pages previews; VPS + Docker for production                  | 10/14 |
| Email           | Resend                                                                  | 11    |
| WhatsApp        | Meta WhatsApp Cloud API                                                 | 11    |
| Payments        | Razorpay (test mode first)                                              | 13    |
| Analytics       | Umami, logs; PostHog/Sentry (paid)                                      | 15    |
