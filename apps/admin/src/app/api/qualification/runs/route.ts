import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { can } from "@/lib/rbac";
import { enqueueQualificationRun, QualificationError } from "@/server/qualification";

export const dynamic = "force-dynamic";

const RUN_FIELDS = {
  id: true,
  status: true,
  scopeType: true,
  businessIds: true,
  discoveryRunId: true,
  researchRunId: true,
  filter: true,
  aiEnabled: true,
  aiProvider: true,
  promptVersion: true,
  rulesVersion: true,
  totalCount: true,
  processedCount: true,
  hotCount: true,
  warmCount: true,
  coldCount: true,
  disqualifiedCount: true,
  errorCount: true,
  factsCheckedCount: true,
  factsVerifiedCount: true,
  factsInvalidCount: true,
  aiOkCount: true,
  aiErrorCount: true,
  aiInputTokens: true,
  aiOutputTokens: true,
  aiCostMinor: true,
  attempts: true,
  error: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
} as const;

/** GET /api/qualification/runs[?id=] : recent qualification runs (any signed-in user). */
export async function GET(req: NextRequest) {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!can(session.user.role, "dashboard:read"))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const id = req.nextUrl.searchParams.get("id");
  if (id) {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    const run = await db.qualificationRun.findUnique({ where: { id }, select: RUN_FIELDS });
    return run
      ? NextResponse.json({ run })
      : NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const runs = await db.qualificationRun.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    select: RUN_FIELDS,
  });
  return NextResponse.json({ runs });
}

/**
 * POST /api/qualification/runs : queue a verification + qualification run (operator+).
 * Body: {scope:"discovery_run", discoveryRunId} | {scope:"research_run", researchRunId} |
 * {scope:"filter", filter:{category?, city?, hasWebsite?, tier?, staleAfterDays?, limit?}} |
 * {scope:"businesses", businessIds[]}, plus ai? ("none"|"mock"|"ollama"|"gemini") and
 * idempotencyKey?. AI is accepted only for a ready provider.
 */
export async function POST(req: NextRequest) {
  // CSRF defence in depth (cookies are SameSite=Lax and JSON needs a preflight anyway).
  const origin = req.headers.get("origin");
  if (origin) {
    let host: string | null = null;
    try {
      host = new URL(origin).host;
    } catch {
      host = null;
    }
    if (host !== req.headers.get("host"))
      return NextResponse.json({ error: "Cross-origin request refused" }, { status: 403 });
  }
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!can(session.user.role, "qualification:run"))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  try {
    const { run, created } = await enqueueQualificationRun(session.user, body);
    return NextResponse.json(
      {
        run: {
          id: run.id,
          status: run.status,
          scopeType: run.scopeType,
          aiProvider: run.aiProvider,
          rulesVersion: run.rulesVersion,
        },
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
    if (err instanceof QualificationError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
