import { NextResponse, type NextRequest } from "next/server";
import { createContact, parseId } from "@/server/crm";
import { crmRoute, readJson, type IdParams } from "@/server/crm-http";

export const dynamic = "force-dynamic";

/**
 * POST /api/crm/leads/[id]/contacts (operator+). Body {personName?, role?, phone?, email?,
 * whatsapp?, isPrimary?, sourceFactId?}; a name or one channel is required.
 */
export async function POST(req: NextRequest, { params }: IdParams) {
  const { id } = await params;
  return crmRoute(req, "crm:write", async (actor) =>
    NextResponse.json(
      { contact: await createContact(actor, parseId(id), await readJson(req)) },
      { status: 201 },
    ),
  );
}
