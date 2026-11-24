import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { can } from "@/lib/rbac";
import { enqueueResearchRun, ResearchError } from "@/server/research";

export const dynamic = "force-dynamic";

const RUN_FIELDS = {
  id: true,
  provider: true,
  status: true,
  scopeType: true,
  businessIds: true,
  discoveryRunId: true,
  filter: true,
  totalCount: true,
  processedCount: true,
  okCount: true,
  noWebsiteCount: true,
  brokenCount: true,
  blockedCount: true,
  errorCount: true,
  factCount: true,
  newFactCount: true,
  conflictCount: true,
  requestCount: true,
  attempts: true,
  error: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
} as const;

/** GET /api/research/runs[?id=] : recent research runs (any signed-in user). */
export async function GET(req: NextRequest) {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!can(session.user.role, "dashboard:read"))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const id = req.nextUrl.searchParams.get("id");
  if (id) {
    const run = await db.researchRun.findUnique({ where: { id }, select: RUN_FIELDS });
    return run
      ? NextResponse.json({ run })
      : NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const runs = await db.researchRun.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    select: RUN_FIELDS,
  });
  return NextResponse.json({ runs });
}

/**
 * POST /api/research/runs : queue a research run (operator+).
 * Body: {scope:"discovery_run", discoveryRunId} | {scope:"filter", filter:{category?, hasWebsite?,
 * staleAfterDays?, limit?}} | {scope:"businesses", businessIds[]}, plus provider? and idempotencyKey?.
 */
export async function POST(req: NextRequest) {
  // CSRF defence in depth (cookies are SameSite=Lax and JSON needs a preflight anyway).
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.headers.get("host"))
    return NextResponse.json({ error: "Cross-origin request refused" }, { status: 403 });
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!can(session.user.role, "research:run"))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  try {
    const { run, created } = await enqueueResearchRun(session.user, body);
    return NextResponse.json(
      {
        run: { id: run.id, status: run.status, provider: run.provider, scopeType: run.scopeType },
        created,
      },
      { status: created ? 202 : 200 },
    );
  } catch (err) {
    if (err instanceof ZodError)
      return NextResponse.json(
        { error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
        { status: 400 },
      );
    if (err instanceof ResearchError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
