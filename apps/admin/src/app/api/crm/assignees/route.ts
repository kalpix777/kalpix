import { NextResponse, type NextRequest } from "next/server";
import { listAssignees } from "@/server/crm";
import { crmRoute } from "@/server/crm-http";

export const dynamic = "force-dynamic";

/** GET /api/crm/assignees : active operators, admins and owners who can be assigned (viewer+). */
export async function GET(req: NextRequest) {
  return crmRoute(req, "crm:read", async (actor) =>
    NextResponse.json({ users: await listAssignees(actor) }),
  );
}
