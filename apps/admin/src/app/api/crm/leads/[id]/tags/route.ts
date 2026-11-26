import { NextResponse, type NextRequest } from "next/server";
import { parseId, setTags } from "@/server/crm";
import { crmRoute, readJson, type IdParams } from "@/server/crm-http";

export const dynamic = "force-dynamic";

/** PUT /api/crm/leads/[id]/tags (operator+). Body {tags: string[]} replaces the lead's tags. */
export async function PUT(req: NextRequest, { params }: IdParams) {
  const { id } = await params;
  return crmRoute(req, "crm:write", async (actor) =>
    NextResponse.json({ tags: await setTags(actor, parseId(id), await readJson(req)) }),
  );
}
