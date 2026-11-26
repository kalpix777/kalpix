import { NextResponse, type NextRequest } from "next/server";
import { changeStage, parseId } from "@/server/crm";
import { crmRoute, readJson, type IdParams } from "@/server/crm-http";

export const dynamic = "force-dynamic";

/**
 * POST /api/crm/leads/[id]/stage (operator+; reopening won/lost needs admin+). Body {version, to,
 * note?, lostReason? (required for lost)}. 400 not allowed, 403 reopen, 409 DNC or stale version.
 */
export async function POST(req: NextRequest, { params }: IdParams) {
  const { id } = await params;
  return crmRoute(req, "crm:write", async (actor) =>
    NextResponse.json({ lead: await changeStage(actor, parseId(id), await readJson(req)) }),
  );
}
