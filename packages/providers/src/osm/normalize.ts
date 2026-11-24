import type { BusinessCandidate, CandidateAddress, KalpixCategory } from "@kalpix/core";
import { classifyTags, type CategoryMap, CATEGORY_MAP } from "../categories";

export const OSM_LICENSE = "ODbL-1.0";
export const OSM_ATTRIBUTION =
  "Data © OpenStreetMap contributors, available under the Open Database License (ODbL). https://www.openstreetmap.org/copyright";
export const OSM_USAGE =
  "ODbL: attribution required; a publicly used derived database must be shared under ODbL.";

export interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

const clean = (v: string | undefined) => {
  const t = v?.replace(/\s+/g, " ").trim();
  return t ? t : undefined;
};
const first = (v: string | undefined) => clean(v?.split(/[;,]/)[0]);

/**
 * Indian-aware phone normalisation to E.164 where unambiguous; otherwise the cleaned original.
 * Only the first of several numbers is kept here; all originals stay in rawTags.
 */
export function normalizePhone(input: string | undefined): string | undefined {
  const raw = first(input);
  if (!raw) return undefined;
  const plus = raw.startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 6) return undefined;
  if (plus) return `+${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `+91${digits}`; // mobile
  if (digits.length === 11 && digits.startsWith("0")) return `+91${digits.slice(1)}`; // STD landline
  return raw;
}

/** Returns a parseable http(s) URL or undefined. Adds http:// when the scheme is missing. */
export function normalizeWebsite(input: string | undefined): string | undefined {
  const raw = first(input);
  if (!raw) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    if (!u.hostname.includes(".")) return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

export function normalizeEmail(input: string | undefined): string | undefined {
  const raw = first(input)?.replace(/^mailto:/i, "");
  return raw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw.toLowerCase() : undefined;
}

export function osmAddress(tags: Record<string, string>): CandidateAddress {
  const a: CandidateAddress = {
    houseNumber: clean(tags["addr:housenumber"]),
    street: clean(tags["addr:street"]),
    locality: clean(tags["addr:suburb"] ?? tags["addr:neighbourhood"] ?? tags["addr:place"]),
    city: clean(tags["addr:city"]),
    district: clean(tags["addr:district"]),
    state: clean(tags["addr:state"]),
    postcode: clean(tags["addr:postcode"]),
    country: clean(tags["addr:country"]),
    full: clean(tags["addr:full"]),
  };
  return Object.fromEntries(Object.entries(a).filter(([, v]) => v)) as CandidateAddress;
}

/**
 * Completeness heuristic, NOT verification: 0.5 for a named, categorised feature, +0.15 with an
 * address, +0.15 with a phone/website/email, +0.1 with opening hours. Capped at 0.9 because
 * nothing is verified in Phase 3.
 */
export function confidenceScore(c: {
  address: CandidateAddress;
  phone?: string;
  website?: string;
  email?: string;
  openingHours?: string;
}): number {
  let s = 0.5;
  if (c.address.street || c.address.full || c.address.postcode) s += 0.15;
  if (c.phone || c.website || c.email) s += 0.15;
  if (c.openingHours) s += 0.1;
  return Math.min(0.9, Math.round(s * 100) / 100);
}

export function normalizeOsmElement(
  el: OverpassElement,
  allowed: readonly KalpixCategory[],
  collectedAt: Date,
  map: CategoryMap = CATEGORY_MAP,
): BusinessCandidate | null {
  const tags = el.tags ?? {};
  const name = clean(tags.name ?? tags["name:en"]);
  if (!name) return null;
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  const cls = classifyTags(tags, allowed, map);
  if (!cls) return null;
  const address = osmAddress(tags);
  const phone = normalizePhone(tags.phone ?? tags["contact:phone"] ?? tags["contact:mobile"]);
  const website = normalizeWebsite(tags.website ?? tags["contact:website"] ?? tags.url);
  const email = normalizeEmail(tags.email ?? tags["contact:email"]);
  const openingHours = clean(tags.opening_hours);
  return {
    provider: "osm-overpass",
    providerId: `${el.type}/${el.id}`,
    name,
    category: cls.category,
    subcategory: cls.subcategory,
    address,
    lat,
    lon,
    phone,
    website,
    email,
    openingHours,
    source: "openstreetmap",
    sourceType: "open_data",
    sourceUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    collectedAt,
    confidence: confidenceScore({ address, phone, website, email, openingHours }),
    license: OSM_LICENSE,
    usageRestrictions: OSM_USAGE,
    rawTags: tags,
  };
}
