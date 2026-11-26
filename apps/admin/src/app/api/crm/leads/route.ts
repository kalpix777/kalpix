import { NextResponse, type NextRequest } from "next/server";
import { parseLeadListFilter } from "@kalpix/core";
import { createLeads, listLeads } from "@/server/crm";
import { crmRoute, readJson } from "@/server/crm-http";

export const dynamic = "force-dynamic";

/**
 * GET /api/crm/leads?stage=&assignee=(me|none|<userId>)&tier=&tag=&overdue=&stale=&contactStatus=&q=&page=
 * Lead list, 50 per page (crm:read: viewer+).
 */
export async function GET(req: NextRequest) {
  return crmRoute(req, "crm:read", async (actor) => {
    const filter = parseLeadListFilter(Object.fromEntries(req.nextUrl.searchParams));
    return NextResponse.json(await listLeads(actor, filter));
  });
}

/**
 * POST /api/crm/leads (crm:write: operator+). Body, one of:
 * {scope:"qualification_run", runId, tiers?, assign?, limit?} | {scope:"businesses", businessIds[],
 * tiers?, assign?} | {scope:"all", tiers?, assign?, limit?} (promotion, idempotent) or
 * {scope:"manual", businessId, assigneeId?, priority?, note?} (one manual lead).
 */
export async function POST(req: NextRequest) {
  return crmRoute(req, "crm:write", async (actor) => {
    const result = await createLeads(actor, await readJson(req));
    if ("manual" in result) return NextResponse.json({ lead: result.manual }, { status: 201 });
    const created = result.promoted.created.length;
    return NextResponse.json(result.promoted, { status: created ? 201 : 200 });
  });
}
