import { NextResponse, type NextRequest } from "next/server";
import { clearContactStatus, parseId, setContactStatus } from "@/server/crm";
import { crmRoute, readJson, type IdParams } from "@/server/crm-http";

export const dynamic = "force-dynamic";

/**
 * POST /api/crm/leads/[id]/dnc (operator+). Body {status: do_not_contact|opted_out, reason,
 * lawfulBasisNote?}. Recorded on the business: blocks outreach stages now and outreach later.
 */
export async function POST(req: NextRequest, { params }: IdParams) {
  const { id } = await params;
  return crmRoute(req, "crm:write", async (actor) =>
    NextResponse.json({
      business: await setContactStatus(actor, parseId(id), await readJson(req)),
    }),
  );
}

/** DELETE /api/crm/leads/[id]/dnc (admin+, crm:dnc_clear). Body {reason}. */
export async function DELETE(req: NextRequest, { params }: IdParams) {
  const { id } = await params;
  return crmRoute(req, "crm:dnc_clear", async (actor) =>
    NextResponse.json({
      business: await clearContactStatus(actor, parseId(id), await readJson(req)),
    }),
  );
}
