import { NextResponse, type NextRequest } from "next/server";
import { editNote, parseId } from "@/server/crm";
import { crmRoute, readJson } from "@/server/crm-http";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ id: string; activityId: string }> };

/** PATCH /api/crm/leads/[id]/activities/[activityId] : edit a note (author only, within 15 minutes). */
export async function PATCH(req: NextRequest, { params }: Params) {
  const { id, activityId } = await params;
  return crmRoute(req, "crm:write", async (actor) =>
    NextResponse.json({
      activity: await editNote(actor, parseId(id), parseId(activityId), await readJson(req)),
    }),
  );
}
