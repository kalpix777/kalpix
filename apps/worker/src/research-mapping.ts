import {
  FACT_NORMALIZED_MAX,
  FACT_SOURCE_URL_MAX,
  FACT_VALUE_MAX,
  type ResearchFact,
  type ResearchField,
  type ResearchSourceType,
  type WebsiteResearchResult,
} from "@kalpix/core";
import {
  canonicalUrl,
  classifySocial,
  normalizeEmailValue,
  normalizeHours,
  normalizeIndianPhone,
  normalizePhone,
} from "@kalpix/providers";

/** The Business columns listing facts are built from. */
export interface ListingBusiness {
  provider: string;
  source: string;
  sourceUrl: string;
  collectedAt: Date;
  confidence: number;
  license: string | null;
  usageRestrictions: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  openingHours: string | null;
  postcode: string | null;
  addressFull: string | null;
  houseNumber: string | null;
  street: string | null;
  locality: string | null;
  city: string | null;
  state: string | null;
  lat: number;
  lon: number;
  name: string;
  rawTags: unknown;
}

export type FactInput = ResearchFact & { provider: string };

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/**
 * The discovery record's values as facts (sourceType "osm" for OpenStreetMap, "listing" for any
 * other discovery provider), so listing and website values share one provenance shape and can be
 * compared for conflicts. All phones/emails/socials in the OSM tags are included, not just the
 * first one copied onto the Business row.
 */
export function listingFacts(b: ListingBusiness): FactInput[] {
  const sourceType: ResearchSourceType = b.source === "openstreetmap" ? "osm" : "listing";
  const out: FactInput[] = [];
  const add = (
    field: ResearchField,
    value: string | null | undefined,
    normalized: string | null,
  ) => {
    if (!value || !normalized) return;
    out.push({
      field,
      value: cap(value.trim(), FACT_VALUE_MAX),
      normalizedValue: cap(normalized, FACT_NORMALIZED_MAX),
      sourceUrl: cap(b.sourceUrl, FACT_SOURCE_URL_MAX),
      sourceType,
      provider: b.provider,
      collectedAt: b.collectedAt,
      confidence: Math.min(1, Math.max(0, b.confidence)),
      verificationStatus: "unverified",
      usageRestriction: b.usageRestrictions ?? b.license ?? undefined,
    });
  };
  const tags =
    b.rawTags && typeof b.rawTags === "object" && !Array.isArray(b.rawTags)
      ? (b.rawTags as Record<string, string>)
      : {};
  const split = (v: string | null | undefined) =>
    (v ?? "")
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter(Boolean);

  add("name", b.name, b.name.toLowerCase().replace(/\s+/g, " ").trim());
  const phones = new Set([
    ...split(b.phone),
    ...split(tags.phone),
    ...split(tags["contact:phone"]),
    ...split(tags["contact:mobile"]),
    ...split(tags.mobile),
  ]);
  // unusual numbers keep their cleaned form so they still take part in conflict checks
  for (const p of phones) add("phone", p, normalizeIndianPhone(p) ?? normalizePhone(p) ?? null);
  for (const e of new Set([
    ...split(b.email),
    ...split(tags.email),
    ...split(tags["contact:email"]),
  ]))
    add("email", e, normalizeEmailValue(e));
  for (const w of split(tags["contact:whatsapp"])) {
    const n = normalizeIndianPhone(w);
    add("whatsapp", w, n);
  }
  if (b.website) {
    const social = classifySocial(b.website);
    if (social?.kind === "social") add(social.field, b.website, social.url);
    else if (social?.kind === "whatsapp") add("whatsapp", b.website, social.phone);
    else add("website", b.website, canonicalUrl(b.website));
  }
  for (const [tag, base] of [
    ["contact:facebook", "https://facebook.com/"],
    ["contact:instagram", "https://instagram.com/"],
    ["contact:twitter", "https://x.com/"],
    ["contact:linkedin", "https://linkedin.com/company/"],
    ["contact:youtube", "https://youtube.com/@"],
  ] as const) {
    const v = tags[tag]?.trim();
    if (!v) continue;
    const url = /^https?:\/\//i.test(v) ? v : `${base}${v.replace(/^@/, "")}`;
    const s = classifySocial(url);
    if (s?.kind === "social") add(s.field, v, s.url);
  }
  if (b.openingHours) add("opening_hours", b.openingHours, normalizeHours(b.openingHours));
  if (b.postcode) {
    const pc = b.postcode.replace(/\s/g, "");
    add("postcode", b.postcode, pc);
  }
  const addr =
    b.addressFull ??
    ([b.houseNumber, b.street, b.locality, b.city, b.state, b.postcode]
      .filter(Boolean)
      .join(", ") ||
      null);
  if (addr) add("address", addr, addr.toLowerCase().replace(/\s+/g, " ").trim());
  add("geo", `${b.lat.toFixed(6)},${b.lon.toFixed(6)}`, `${b.lat.toFixed(5)},${b.lon.toFixed(5)}`);
  return uniqueFacts(out);
}

/** Website facts from a provider result, tagged with the provider id. */
export function websiteFacts(r: WebsiteResearchResult, provider: string): FactInput[] {
  return r.facts
    .filter((f) => f.sourceUrl.length <= FACT_SOURCE_URL_MAX)
    .map((f) => ({
      ...f,
      value: cap(f.value, FACT_VALUE_MAX),
      normalizedValue: cap(f.normalizedValue, FACT_NORMALIZED_MAX),
      confidence: Math.min(1, Math.max(0, f.confidence)),
      provider,
    }));
}

/** Dedupes facts on the unique key (businessId is implicit), keeping the most confident. */
export function uniqueFacts(facts: FactInput[]): FactInput[] {
  const m = new Map<string, FactInput>();
  for (const f of facts) {
    const k = `${f.field}\u0000${f.normalizedValue}\u0000${f.sourceUrl}`;
    const prev = m.get(k);
    if (!prev || f.confidence > prev.confidence) m.set(k, f);
  }
  return [...m.values()];
}
