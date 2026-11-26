import { NextResponse, type NextRequest } from "next/server";
import { deleteContact, parseId, updateContact } from "@/server/crm";
import { crmRoute, readJson } from "@/server/crm-http";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ id: string; contactId: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id, contactId } = await params;
  return crmRoute(req, "crm:write", async (actor) =>
    NextResponse.json({
      contact: await updateContact(actor, parseId(id), parseId(contactId), await readJson(req)),
    }),
  );
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const { id, contactId } = await params;
  return crmRoute(req, "crm:write", async (actor) =>
    NextResponse.json(await deleteContact(actor, parseId(id), parseId(contactId))),
  );
}
