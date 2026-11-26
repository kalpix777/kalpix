import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { CrmError, importLeads } from "@/server/crm";
import { crmRoute } from "@/server/crm-http";

export const dynamic = "force-dynamic";

const jsonBody = z.object({ csv: z.string().min(1), dryRun: z.boolean().optional() });

/**
 * POST /api/crm/leads/import[?dryRun=1] (crm:import: admin+). Body: the CSV itself
 * (content-type text/csv) or JSON {csv, dryRun?}. Returns per-line errors and skips.
 */
export async function POST(req: NextRequest) {
  return crmRoute(req, "crm:import", async (actor) => {
    const type = req.headers.get("content-type") ?? "";
    let csv: string;
    let dryRun = ["1", "true", "yes"].includes(req.nextUrl.searchParams.get("dryRun") ?? "");
    if (type.startsWith("text/csv") || type.startsWith("text/plain")) csv = await req.text();
    else if (type.startsWith("application/json")) {
      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        throw new CrmError("Body must be JSON", 400);
      }
      const body = jsonBody.parse(raw);
      csv = body.csv;
      dryRun = body.dryRun ?? dryRun;
    } else throw new CrmError("Send text/csv or application/json {csv}", 415);
    const result = await importLeads(actor, csv, { dryRun });
    const status = dryRun ? 200 : result.created.length ? 201 : 200;
    return NextResponse.json(result, { status });
  });
}
