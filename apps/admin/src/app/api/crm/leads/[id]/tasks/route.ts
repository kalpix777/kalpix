import { NextResponse, type NextRequest } from "next/server";
import { createTask, parseId } from "@/server/crm";
import { crmRoute, readJson, type IdParams } from "@/server/crm-http";

export const dynamic = "force-dynamic";

/** POST /api/crm/leads/[id]/tasks (operator+). Body {title, dueAt?, assigneeId? (default: you)}. */
export async function POST(req: NextRequest, { params }: IdParams) {
  const { id } = await params;
  return crmRoute(req, "crm:write", async (actor) =>
    NextResponse.json(
      { task: await createTask(actor, parseId(id), await readJson(req)) },
      { status: 201 },
    ),
  );
}
