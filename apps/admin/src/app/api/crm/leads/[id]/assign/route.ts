import { NextResponse, type NextRequest } from "next/server";
import { assignLead, parseId } from "@/server/crm";
import { crmRoute, readJson, type IdParams } from "@/server/crm-http";

export const dynamic = "force-dynamic";

/** POST /api/crm/leads/[id]/assign (operator+). Body {version, assigneeId | null}. */
export async function POST(req: NextRequest, { params }: IdParams) {
  const { id } = await params;
  return crmRoute(req, "crm:write", async (actor) =>
    NextResponse.json({ lead: await assignLead(actor, parseId(id), await readJson(req)) }),
  );
}
