import { NextResponse, type NextRequest } from "next/server";
import { parseLeadListFilter } from "@kalpix/core";
import { exportLeads } from "@/server/crm";
import { crmRoute } from "@/server/crm-http";

export const dynamic = "force-dynamic";

/** GET /api/crm/leads/export?<list filters> : CSV of the filtered leads (crm:export: admin+). */
export async function GET(req: NextRequest) {
  return crmRoute(req, "crm:export", async (actor) => {
    const filter = parseLeadListFilter(Object.fromEntries(req.nextUrl.searchParams));
    const { csv } = await exportLeads(actor, filter);
    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="kalpix-leads-${stamp}.csv"`,
        "cache-control": "no-store",
      },
    });
  });
}
