# Product Roadmap

| #   | Phase                                 | Status                                    |
| --- | ------------------------------------- | ----------------------------------------- |
| 1   | Environment and project setup         | Built; local checks on owner machine open |
| 2   | Core app, database, admin dashboard   | Approved                                  |
| 3   | Business discovery engine             | Approved                                  |
| 4   | Business research and extraction      | Approved                                  |
| 5   | Verification and AI qualification     | Approved                                  |
| 6   | CRM and lead management               | Built and tested; awaiting approval       |
| 7   | AI website planning                   | Not started                               |
| 8   | AI website generation                 | Not started                               |
| 9   | Website testing and QA                | Not started                               |
| 10  | Demo hosting and deployment           | Not started                               |
| 11  | WhatsApp, email, owner notifications  | Not started                               |
| 12  | Outreach and enquiry management       | Not started                               |
| 13  | Quotations, payments, invoicing       | Not started                               |
| 14  | Production delivery and maintenance   | Not started                               |
| 15  | Analytics, security, launch readiness | Not started                               |

Each phase ships with requirements, architecture, tools, free implementation, paid upgrades, database changes, tasks, tests, documentation, acceptance criteria and cost notes. A phase is complete only when its acceptance criteria pass and the owner approves.

## Phase 1 plan

- **A. Hardware/OS:** `pnpm doctor` reports OS, CPU, RAM, disk, GPU and a local-AI verdict (under 16 GB RAM: hosted API free tiers; 16-32 GB: small quantized models; 32 GB+: 7B-14B via Ollama).
- **B. Node and package manager:** Node 22 LTS pinned in `.nvmrc`; pnpm via Corepack, pinned in `packageManager`; `engine-strict`.
- **C. Antigravity + REA MCP:** not reinstalled. Doctor looks for MCP configs in known locations and flags any REA-named server; final confirmation is manual inside Antigravity.
- **D. Git/GitHub:** repo initialised on `main`; CI workflow in `.github/workflows/ci.yml`; branch protection and private repo set manually.
- **E. Docker:** Docker Desktop (or Docker Engine on Linux) for local services only.
- **F. PostgreSQL:** PostgreSQL 16 in Docker, bound to 127.0.0.1, named volume, healthcheck. `pnpm db:check` verifies connectivity.
- **G. Dependencies:** TypeScript, ESLint, Prettier, Vitest, zod, pg, dotenv. Nothing else until a phase needs it.
- **H. Architecture:** pnpm monorepo, modular monolith: `apps/*`, `packages/*`, `infra/*`.
- **I. Env strategy:** `.env.example` committed, `.env` ignored; zod-validated at startup; secrets server-side only; production guards.
- **J. Dev/prod separation:** `APP_ENV`; separate databases, keys and Razorpay test vs live; production refuses dev defaults and test keys.
- **K. Backup/security:** `pnpm db:backup` (14 rotating dumps); secrets never in Git; DB on localhost only; CI with throwaway credentials.
- **L. Cost:** Rs 0 for Phase 1 (all free tools).
