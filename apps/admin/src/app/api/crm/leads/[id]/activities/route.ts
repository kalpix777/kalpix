import { NextResponse, type NextRequest } from "next/server";
import { addActivity, parseId } from "@/server/crm";
import { crmRoute, readJson, type IdParams } from "@/server/crm-http";

export const dynamic = "force-dynamic";

/** POST /api/crm/leads/[id]/activities (operator+). Body {type: note|call_logged|meeting_logged, body, occurredAt?}. */
export async function POST(req: NextRequest, { params }: IdParams) {
  const { id } = await params;
  return crmRoute(req, "crm:write", async (actor) =>
    NextResponse.json(
      { activity: await addActivity(actor, parseId(id), await readJson(req)) },
      { status: 201 },
    ),
  );
}
