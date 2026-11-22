import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { can, isAdminRole, type Permission } from "@/lib/rbac";

export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}

export async function requireUser() {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

export async function requirePermission(permission: Permission) {
  const session = await requireUser();
  if (!can(session.user.role, permission)) redirect("/?denied=1");
  return session;
}

/** Throws instead of redirecting: for server actions. */
export async function assertPermission(permission: Permission) {
  const session = await getSession();
  if (!session) throw new Error("Not signed in");
  if (!can(session.user.role, permission))
    throw new Error("You do not have permission for this action");
  return session;
}

/** Admins must enable MFA. Enforced in production; warned in development. */
export function mfaRequired(user: { role?: string | null; twoFactorEnabled?: boolean | null }) {
  const enforce =
    (process.env.REQUIRE_ADMIN_MFA ?? (process.env.APP_ENV === "production" ? "true" : "false")) ===
    "true";
  const missing = isAdminRole(user.role) && !user.twoFactorEnabled;
  return { missing, enforce };
}
