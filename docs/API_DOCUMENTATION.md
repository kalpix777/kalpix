# API Documentation

## HTTP

| Route         | Method   | Purpose                                                                                    |
| ------------- | -------- | ------------------------------------------------------------------------------------------ |
| `/api/auth/*` | GET/POST | Better Auth: sign-in, sign-out, session, two-factor enable/verify/disable, admin endpoints |

Used by the dashboard: `POST /api/auth/sign-in/email`, `POST /api/auth/sign-out`, `POST /api/auth/two-factor/enable`, `POST /api/auth/two-factor/verify-totp`, `POST /api/auth/two-factor/disable`. Public `sign-up/email` is disabled (400). Auth routes are rate limited, with a stricter limit on sign-in.

## Server actions

Every action validates with zod, checks RBAC server-side and writes an audit entry.

| Action                        | Permission       | Rule                                                                                     |
| ----------------------------- | ---------------- | ---------------------------------------------------------------------------------------- |
| toggleProvider                | providers:manage | Enabling needs keys present and commercial terms verified; paid/freemium needs the owner |
| setCommercialVerified         | owner            | Unverifying also disables                                                                |
| updateProviderLimits          | providers:manage | Monthly units, budget, fallback                                                          |
| createTeamMember              | users:manage     | Admins cannot create owners                                                              |
| changeRole                    | users:manage     | No self-change; at least one owner remains                                               |
| setSuspended                  | users:manage     | Revokes all sessions                                                                     |
| updateSettings                | settings:write   | Only the owner can switch an approval rule off                                           |
| createPackage / togglePackage | pricing:manage   | DEMO packages cannot be activated                                                        |

## Internal modules

- `@kalpix/config`: `loadEnv`, `integrationStatus`.
- `@kalpix/core`: `Provider`, `ProviderDescriptor`, `Result`, `canEnable`.
- `apps/admin/src/lib/rbac.ts`: `can`, `canAssignRole`, `isAdminRole`.
- `apps/admin/src/lib/provider-registry.ts`: default catalogue, `secretStatus` (names only).

## Scripts

`pnpm doctor`, `pnpm db:check`, `pnpm db:backup`, `pnpm db:deploy`, `pnpm db:seed`, `pnpm dev`, `pnpm build`, `pnpm start`, `pnpm e2e`.
