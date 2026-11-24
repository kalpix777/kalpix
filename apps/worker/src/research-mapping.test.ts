import { describe, expect, it } from "vitest";
import { detectConflicts } from "@kalpix/core";
import { listingFacts, uniqueFacts, websiteFacts, type ListingBusiness } from "./research-mapping";

const osm: ListingBusiness = {
  provider: "osm-overpass",
  source: "openstreetmap",
  sourceUrl: "https://www.openstreetmap.org/node/1",
  collectedAt: new Date("2026-11-20T00:00:00Z"),
  confidence: 0.8,
  license: "ODbL-1.0",
  usageRestrictions: "ODbL: attribution required",
  phone: "+918312461234",
  email: null,
  website: "https://www.facebook.com/SagarBgm",
  openingHours: "Mo-Sa 09:00-22:00",
  postcode: "590 006",
  addressFull: null,
  houseNumber: "12",
  street: "Congress Road",
  locality: null,
  city: "Belagavi",
  state: null,
  lat: 15.8497,
  lon: 74.4977,
  name: "Shree  Sagar",
  rawTags: { phone: "+91 831 246 1234; +91 98450 12345", "contact:instagram": "sagar.bgm" },
};

describe("listingFacts", () => {
  const facts = listingFacts(osm);
  const by = (f: string) => facts.filter((x) => x.field === f).map((x) => x.normalizedValue);

  it("turns the OSM record into facts with uniform provenance", () => {
    for (const f of facts)
      expect(f).toMatchObject({
        sourceType: "osm",
        provider: "osm-overpass",
        sourceUrl: "https://www.openstreetmap.org/node/1",
        confidence: 0.8,
        verificationStatus: "unverified",
        usageRestriction: "ODbL: attribution required",
      });
  });
  it("includes every OSM phone, social profiles, hours, postcode, address and geo", () => {
    expect(by("phone").sort()).toEqual(["+918312461234", "+919845012345"]);
    expect(by("social_facebook")).toEqual(["https://facebook.com/sagarbgm"]);
    expect(by("social_instagram")).toEqual(["https://instagram.com/sagar.bgm"]);
    expect(by("website")).toEqual([]); // the listed "website" is a Facebook page
    expect(by("opening_hours")).toEqual(["mo-sa 09:00-22:00"]);
    expect(by("postcode")).toEqual(["590006"]);
    expect(by("address")).toEqual(["12, congress road, belagavi, 590 006"]);
    expect(by("geo")).toEqual(["15.84970,74.49770"]);
    expect(by("name")).toEqual(["shree sagar"]);
  });
  it("uses sourceType listing for non-OSM discovery records and keeps odd phones", () => {
    const f = listingFacts({
      ...osm,
      source: "mock",
      provider: "mock-discovery",
      phone: "+910000000000",
      rawTags: null,
    });
    expect(f.every((x) => x.sourceType === "listing")).toBe(true);
    expect(f.find((x) => x.field === "phone")?.normalizedValue).toBe("+910000000000");
  });
  it("feeds conflict detection with website facts", () => {
    const web = websiteFacts(
      {
        status: "ok",
        requests: 2,
        summary: "",
        signals: { noWebsite: false },
        facts: [
          {
            field: "phone",
            value: "0831 246 9999",
            normalizedValue: "+918312469999",
            sourceUrl: "https://sagar.example.in/contact",
            sourceType: "microdata",
            collectedAt: new Date(),
            confidence: 0.75,
            verificationStatus: "unverified",
          },
        ],
      },
      "http-extractor",
    );
    expect(web[0]?.provider).toBe("http-extractor");
    expect([...detectConflicts([...facts, ...web])]).toEqual(["phone"]);
  });
  it("uniqueFacts keeps the most confident duplicate", () => {
    const a = facts[0]!;
    expect(uniqueFacts([a, { ...a, confidence: 0.9 }, a])).toEqual([{ ...a, confidence: 0.9 }]);
  });
});
