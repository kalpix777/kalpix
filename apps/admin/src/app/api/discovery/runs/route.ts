import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { can } from "@/lib/rbac";
import { DiscoveryError, enqueueDiscoveryRun } from "@/server/discovery";

export const dynamic = "force-dynamic";

const RUN_FIELDS = {
  id: true,
  area: true,
  areaDisplayName: true,
  categories: true,
  provider: true,
  status: true,
  foundCount: true,
  createdCount: true,
  updatedCount: true,
  duplicateCount: true,
  skippedCount: true,
  requestCount: true,
  completedCategories: true,
  attempts: true,
  error: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
} as const;

/** GET /api/discovery/runs[?id=] : recent runs (any signed-in user). */
export async function GET(req: NextRequest) {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!can(session.user.role, "dashboard:read"))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const id = req.nextUrl.searchParams.get("id");
  if (id) {
    const run = await db.discoveryRun.findUnique({ where: { id }, select: RUN_FIELDS });
    return run
      ? NextResponse.json({ run })
      : NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const runs = await db.discoveryRun.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    select: RUN_FIELDS,
  });
  return NextResponse.json({ runs });
}

/** POST /api/discovery/runs {area, categories[], idempotencyKey?} : queue a run (operator+). */
export async function POST(req: NextRequest) {
  // CSRF defence in depth (cookies are SameSite=Lax and JSON needs a preflight anyway).
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.headers.get("host"))
    return NextResponse.json({ error: "Cross-origin request refused" }, { status: 403 });
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!can(session.user.role, "discovery:run"))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  try {
    const { run, created } = await enqueueDiscoveryRun(session.user, body);
    return NextResponse.json(
      { run: { id: run.id, status: run.status, provider: run.provider }, created },
      { status: created ? 202 : 200 },
    );
  } catch (err) {
    if (err instanceof ZodError)
      return NextResponse.json(
        { error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
        { status: 400 },
      );
    if (err instanceof DiscoveryError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
