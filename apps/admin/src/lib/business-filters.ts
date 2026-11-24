import type { Prisma } from "@prisma/client";
import { isKalpixCategory } from "@kalpix/core";

export interface BusinessFilters {
  category?: string;
  website?: string; // "yes" | "no" | ""
  phone?: string; // "yes" | "no" | ""
  q?: string;
  run?: string;
}

/** Parses untrusted query-string filters into a safe shape (unknown values are dropped). */
export function parseBusinessFilters(sp: Record<string, string | string[] | undefined>) {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
  const category = one(sp.category);
  const website = one(sp.website);
  const phone = one(sp.phone);
  const run = one(sp.run);
  return {
    category: isKalpixCategory(category) ? category : "",
    website: website === "yes" || website === "no" ? website : "",
    phone: phone === "yes" || phone === "no" ? phone : "",
    q: one(sp.q).slice(0, 100),
    run: /^[0-9a-f-]{36}$/i.test(run) ? run : "",
  };
}

export function businessWhere(f: BusinessFilters): Prisma.BusinessWhereInput {
  const and: Prisma.BusinessWhereInput[] = [];
  if (f.category) and.push({ category: f.category });
  if (f.website === "yes") and.push({ hasWebsite: true });
  if (f.website === "no") and.push({ hasWebsite: false });
  if (f.phone === "yes") and.push({ phone: { not: null } });
  if (f.phone === "no") and.push({ phone: null });
  if (f.run) and.push({ OR: [{ firstRunId: f.run }, { lastRunId: f.run }] });
  if (f.q) {
    const contains = { contains: f.q, mode: "insensitive" as const };
    and.push({
      OR: [
        { name: contains },
        { street: contains },
        { locality: contains },
        { city: contains },
        { phone: { contains: f.q } },
        { website: contains },
      ],
    });
  }
  return and.length ? { AND: and } : {};
}

export function filtersToQuery(f: BusinessFilters, extra: Record<string, string> = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...f, ...extra })) if (v) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}
