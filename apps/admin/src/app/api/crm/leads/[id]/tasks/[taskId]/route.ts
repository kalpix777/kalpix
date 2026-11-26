import { NextResponse, type NextRequest } from "next/server";
import { cancelTask, parseId, updateTask } from "@/server/crm";
import { crmRoute, readJson } from "@/server/crm-http";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ id: string; taskId: string }> };

/** PATCH /api/crm/leads/[id]/tasks/[taskId] (operator+). Body {title?, dueAt?, assigneeId?, status?}. */
export async function PATCH(req: NextRequest, { params }: Params) {
  const { id, taskId } = await params;
  return crmRoute(req, "crm:write", async (actor) =>
    NextResponse.json({
      task: await updateTask(actor, parseId(id), parseId(taskId), await readJson(req)),
    }),
  );
}

/** DELETE /api/crm/leads/[id]/tasks/[taskId] : cancels the task (kept for the record). */
export async function DELETE(req: NextRequest, { params }: Params) {
  const { id, taskId } = await params;
  return crmRoute(req, "crm:write", async (actor) =>
    NextResponse.json({ task: await cancelTask(actor, parseId(id), parseId(taskId)) }),
  );
}
