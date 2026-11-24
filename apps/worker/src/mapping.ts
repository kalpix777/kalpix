import type { BusinessCandidate } from "@kalpix/core";
import { normalizeName } from "@kalpix/providers";

/** Columns written from a candidate on create. Pure, so it is unit-tested without a database. */
export function candidateToCreate(c: BusinessCandidate, runId: string) {
  const [osmType, osmId] =
    c.source === "openstreetmap" ? (c.providerId.split("/") as [string, string]) : [null, null];
  return {
    name: c.name,
    normalizedName: normalizeName(c.name),
    category: c.category,
    subcategory: c.subcategory ?? null,
    provider: c.provider,
    providerId: c.providerId,
    osmType,
    osmId,
    ...addressColumns(c),
    lat: c.lat,
    lon: c.lon,
    phone: c.phone ?? null,
    website: c.website ?? null,
    email: c.email ?? null,
    openingHours: c.openingHours ?? null,
    hasWebsite: Boolean(c.website),
    source: c.source,
    sourceType: c.sourceType,
    sourceUrl: c.sourceUrl,
    collectedAt: c.collectedAt,
    lastSeenAt: c.collectedAt,
    confidence: c.confidence,
    license: c.license ?? null,
    usageRestrictions: c.usageRestrictions ?? null,
    rawTags: c.rawTags ?? undefined,
    firstRunId: runId,
    lastRunId: runId,
  };
}

function addressColumns(c: BusinessCandidate) {
  const a = c.address;
  return {
    houseNumber: a.houseNumber ?? null,
    street: a.street ?? null,
    locality: a.locality ?? null,
    city: a.city ?? null,
    district: a.district ?? null,
    state: a.state ?? null,
    postcode: a.postcode ?? null,
    country: a.country ?? null,
    addressFull: a.full ?? null,
  };
}

/**
 * Same provider record seen again: the provider is the source of truth for its own fields, so
 * they are refreshed. Category, status, firstRunId and createdAt are never changed here.
 */
export function candidateToRefresh(c: BusinessCandidate, runId: string) {
  return {
    name: c.name,
    normalizedName: normalizeName(c.name),
    subcategory: c.subcategory ?? null,
    ...addressColumns(c),
    lat: c.lat,
    lon: c.lon,
    phone: c.phone ?? null,
    website: c.website ?? null,
    email: c.email ?? null,
    openingHours: c.openingHours ?? null,
    hasWebsite: Boolean(c.website),
    sourceUrl: c.sourceUrl,
    collectedAt: c.collectedAt,
    lastSeenAt: c.collectedAt,
    confidence: c.confidence,
    rawTags: c.rawTags ?? undefined,
    lastRunId: runId,
  };
}

/**
 * Fuzzy duplicate from another record: keep the existing row, remember the other id, and only
 * fill contact fields that are empty (never overwrite one source with another).
 */
export function mergeIntoExisting(
  existing: {
    alternateIds: string[];
    phone: string | null;
    website: string | null;
    email: string | null;
    openingHours: string | null;
  },
  c: BusinessCandidate,
  runId: string,
) {
  const alt = `${c.provider}:${c.providerId}`;
  const website = existing.website ?? c.website ?? null;
  return {
    alternateIds: existing.alternateIds.includes(alt)
      ? existing.alternateIds
      : [...existing.alternateIds, alt],
    phone: existing.phone ?? c.phone ?? null,
    website,
    email: existing.email ?? c.email ?? null,
    openingHours: existing.openingHours ?? c.openingHours ?? null,
    hasWebsite: Boolean(website),
    lastSeenAt: c.collectedAt,
    lastRunId: runId,
  };
}
