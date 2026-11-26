import { NextResponse, type NextRequest } from "next/server";
import { listTags } from "@/server/crm";
import { crmRoute } from "@/server/crm-http";

export const dynamic = "force-dynamic";

/** GET /api/crm/tags : all tags with lead counts (viewer+). */
export async function GET(req: NextRequest) {
  return crmRoute(req, "crm:read", async (actor) =>
    NextResponse.json({ tags: await listTags(actor) }),
  );
}
