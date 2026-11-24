import { describe, expect, it } from "vitest";
import type { BusinessCandidate } from "@kalpix/core";
import { candidateToCreate, candidateToRefresh, mergeIntoExisting } from "./mapping";

const c: BusinessCandidate = {
  provider: "osm-overpass",
  providerId: "node/42",
  name: "Hotel Sanman",
  category: "restaurants",
  subcategory: "amenity=restaurant",
  address: { street: "College Road", city: "Belagavi" },
  lat: 15.86,
  lon: 74.51,
  phone: "+918312422222",
  source: "openstreetmap",
  sourceType: "open_data",
  sourceUrl: "https://www.openstreetmap.org/node/42",
  collectedAt: new Date("2026-11-22T00:00:00Z"),
  confidence: 0.8,
  license: "ODbL-1.0",
};

describe("candidate -> Business columns", () => {
  it("keeps provenance, splits the OSM id and flags missing websites", () => {
    const d = candidateToCreate(c, "run1");
    expect(d).toMatchObject({
      osmType: "node",
      osmId: "42",
      normalizedName: "hotel sanman",
      hasWebsite: false,
      sourceUrl: "https://www.openstreetmap.org/node/42",
      license: "ODbL-1.0",
      collectedAt: c.collectedAt,
      lastSeenAt: c.collectedAt,
      firstRunId: "run1",
      lastRunId: "run1",
      street: "College Road",
      postcode: null,
    });
    expect(candidateToCreate({ ...c, website: "https://x.in/" }, "r").hasWebsite).toBe(true);
    expect(
      candidateToCreate({ ...c, source: "mock", providerId: "mock/a/1" }, "r").osmId,
    ).toBeNull();
  });
  it("refresh never changes category, status or first run", () => {
    const d = candidateToRefresh(c, "run2");
    expect(d).not.toHaveProperty("category");
    expect(d).not.toHaveProperty("status");
    expect(d).not.toHaveProperty("firstRunId");
    expect(d.lastRunId).toBe("run2");
  });
  it("fuzzy merge only fills empty fields and records the alternate id once", () => {
    const existing = {
      alternateIds: [],
      phone: "+911",
      website: null,
      email: null,
      openingHours: null,
    };
    const m = mergeIntoExisting(existing, { ...c, website: "https://x.in/", phone: "+912" }, "r");
    expect(m).toMatchObject({
      phone: "+911",
      website: "https://x.in/",
      hasWebsite: true,
      alternateIds: ["osm-overpass:node/42"],
    });
    expect(
      mergeIntoExisting({ ...existing, alternateIds: m.alternateIds }, c, "r").alternateIds,
    ).toHaveLength(1);
  });
});
