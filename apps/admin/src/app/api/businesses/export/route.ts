import { NextResponse, type NextRequest } from "next/server";
import { OSM_ATTRIBUTION, toCsv } from "@kalpix/providers";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { businessWhere, parseBusinessFilters } from "@/lib/business-filters";
import { can } from "@/lib/rbac";
import { recordAudit } from "@/server/audit";

export const dynamic = "force-dynamic";
const MAX_ROWS = 50_000;

const HEADERS = [
  "id",
  "name",
  "category",
  "subcategory",
  "status",
  "house_number",
  "street",
  "locality",
  "city",
  "district",
  "state",
  "postcode",
  "lat",
  "lon",
  "phone",
  "website",
  "has_website",
  "email",
  "opening_hours",
  "confidence",
  "verification_status",
  "provider",
  "provider_id",
  "source",
  "source_type",
  "source_url",
  "license",
  "attribution",
  "collected_at",
  "last_seen_at",
];

/** GET /api/businesses/export?category=&website=&q=&run= : CSV of the filtered list (admin+). */
export async function GET(req: NextRequest) {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!can(session.user.role, "businesses:export"))
    return NextResponse.json({ error: "Only admins and owners can export" }, { status: 403 });
  const filters = parseBusinessFilters(Object.fromEntries(req.nextUrl.searchParams));
  const rows = await db.business.findMany({
    where: businessWhere(filters),
    orderBy: [{ category: "asc" }, { name: "asc" }],
    take: MAX_ROWS,
  });
  const csv = toCsv(
    HEADERS,
    rows.map((b) => [
      b.id,
      b.name,
      b.category,
      b.subcategory,
      b.status,
      b.houseNumber,
      b.street,
      b.locality,
      b.city,
      b.district,
      b.state,
      b.postcode,
      b.lat,
      b.lon,
      b.phone,
      b.website,
      b.hasWebsite,
      b.email,
      b.openingHours,
      b.confidence,
      b.verificationStatus,
      b.provider,
      b.providerId,
      b.source,
      b.sourceType,
      b.sourceUrl,
      b.license,
      b.source === "openstreetmap" ? OSM_ATTRIBUTION : b.usageRestrictions,
      b.collectedAt,
      b.lastSeenAt,
    ]),
  );
  await recordAudit({
    actorId: session.user.id,
    actorLabel: session.user.email,
    action: "business.export",
    entityType: "business",
    metadata: { filters, rows: rows.length, truncated: rows.length === MAX_ROWS },
  });
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="kalpix-businesses-${stamp}.csv"`,
      "cache-control": "no-store",
    },
  });
}
