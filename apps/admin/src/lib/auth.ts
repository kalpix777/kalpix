import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { admin, twoFactor } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/admin/access";
import { db } from "./db";

// Better Auth access control for its admin endpoints. App-level permissions live in rbac.ts.
const ac = createAccessControl(defaultStatements);
const manageUsers = {
  user: ["create", "list", "set-role", "ban", "delete", "set-password", "get", "update"],
  session: ["list", "revoke", "delete"],
} as const;
const authRoles = {
  owner: ac.newRole(manageUsers),
  admin: ac.newRole(manageUsers),
  operator: ac.newRole({ user: [], session: [] }),
  viewer: ac.newRole({ user: [], session: [] }),
};

export const auth = betterAuth({
  appName: "Kalpix",
  baseURL: process.env.APP_URL,
  secret: process.env.AUTH_SECRET,
  database: prismaAdapter(db, { provider: "postgresql" }),
  telemetry: { enabled: false },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    // Public sign-up is disabled: users are created by an owner/admin or the seed script.
    disableSignUp: true,
  },
  session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
  rateLimit: { enabled: true, window: 60, max: 30 },
  databaseHooks: {
    session: {
      create: {
        after: async (session) => {
          const user = await db.user.findUnique({
            where: { id: session.userId },
            select: { email: true },
          });
          await db.auditLog.create({
            data: {
              actorId: session.userId,
              actorLabel: user?.email ?? "unknown",
              action: "auth.sign_in",
              entityType: "session",
              ipAddress: session.ipAddress ?? null,
              metadata: { userAgent: session.userAgent ?? null },
            },
          });
        },
      },
    },
  },
  plugins: [
    twoFactor({ issuer: "Kalpix" }),
    admin({ ac, roles: authRoles, defaultRole: "viewer", adminRoles: ["owner", "admin"] }),
    nextCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
