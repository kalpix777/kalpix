import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { auth } from "@/lib/auth";
import { can, type Permission } from "@/lib/rbac";
import { CrmError, type Actor } from "./crm";

/** Same-origin check for state-changing requests (CSRF defence in depth, as the other routes). */
export function crossOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.get("host");
  } catch {
    return true;
  }
}

export async function readJson(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new CrmError("Body must be JSON", 400);
  }
}

/**
 * Wraps a CRM route: origin check (non-GET), session (401), coarse permission (403), then maps
 * ZodError -> 400 and CrmError -> its status, as JSON {error, ...}. Finer rules (reopen, DNC clear,
 * version conflicts) are enforced in src/server/crm.ts.
 */
export async function crmRoute(
  req: NextRequest,
  permission: Permission,
  fn: (actor: Actor) => Promise<Response>,
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD" && crossOrigin(req))
    return NextResponse.json({ error: "Cross-origin request refused" }, { status: 403 });
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!can(session.user.role, permission))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    return await fn({ id: session.user.id, email: session.user.email, role: session.user.role });
  } catch (err) {
    if (err instanceof ZodError)
      return NextResponse.json(
        { error: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") },
        { status: 400 },
      );
    if (err instanceof CrmError)
      return NextResponse.json({ error: err.message, ...err.extra }, { status: err.status });
    throw err;
  }
}

export type IdParams = { params: Promise<{ id: string }> };
