import { NextResponse, type NextRequest } from "next/server";
import { getLead, parseId, updateLead } from "@/server/crm";
import { crmRoute, readJson, type IdParams } from "@/server/crm-http";

export const dynamic = "force-dynamic";

/** GET /api/crm/leads/[id] : lead with business, contacts, tags, tasks, timeline, history (viewer+). */
export async function GET(req: NextRequest, { params }: IdParams) {
  const { id } = await params;
  return crmRoute(req, "crm:read", async (actor) =>
    NextResponse.json({ lead: await getLead(actor, parseId(id)) }),
  );
}

/**
 * PATCH /api/crm/leads/[id] (operator+). Body {version, priority?, valueEstimatePaise?,
 * nextFollowUpAt?, lawfulBasisNote?}. A stale version is 409 {error, currentVersion}.
 */
export async function PATCH(req: NextRequest, { params }: IdParams) {
  const { id } = await params;
  return crmRoute(req, "crm:write", async (actor) =>
    NextResponse.json({ lead: await updateLead(actor, parseId(id), await readJson(req)) }),
  );
}
