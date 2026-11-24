import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/overpass-belagavi.json";
import {
  confidenceScore,
  normalizeEmail,
  normalizeOsmElement,
  normalizePhone,
  normalizeWebsite,
  type OverpassElement,
} from "./osm/normalize";

const at = new Date("2026-11-22T10:00:00Z");
const els = fixture.elements as unknown as OverpassElement[];

describe("normalisation", () => {
  it("normalises Indian phone numbers to E.164 when unambiguous", () => {
    expect(normalizePhone("0831 242 2222; 98450 12345")).toBe("+918312422222");
    expect(normalizePhone("98450-12345")).toBe("+919845012345");
    expect(normalizePhone("+91 831 240 0000")).toBe("+918312400000");
    expect(normalizePhone("919845012345")).toBe("+919845012345");
    expect(normalizePhone("2422222")).toBe("2422222");
    expect(normalizePhone("123")).toBeUndefined();
    expect(normalizePhone(undefined)).toBeUndefined();
  });
  it("normalises websites and rejects junk", () => {
    expect(normalizeWebsite("fixture-udupi.example.in")).toBe("http://fixture-udupi.example.in/");
    expect(normalizeWebsite("https://a.example/x")).toBe("https://a.example/x");
    expect(normalizeWebsite("ftp://a.example")).toBeUndefined();
    expect(normalizeWebsite("not a url")).toBeUndefined();
    expect(normalizeWebsite("localhost")).toBeUndefined();
  });
  it("normalises emails", () => {
    expect(normalizeEmail("mailto:Service@Fixture-Motors.example")).toBe(
      "service@fixture-motors.example",
    );
    expect(normalizeEmail("nope")).toBeUndefined();
  });
  it("maps a full OSM node to a candidate with provenance", () => {
    const c = normalizeOsmElement(els[0]!, ["restaurants"], at)!;
    expect(c).toMatchObject({
      provider: "osm-overpass",
      providerId: "node/1001",
      name: "Fixture Udupi Hotel",
      category: "restaurants",
      subcategory: "amenity=restaurant",
      address: { street: "College Road", city: "Belagavi", postcode: "590001" },
      lat: 15.8601,
      lon: 74.5101,
      phone: "+918312422222",
      website: "http://fixture-udupi.example.in/",
      openingHours: "Mo-Su 07:00-22:00",
      source: "openstreetmap",
      sourceType: "open_data",
      sourceUrl: "https://www.openstreetmap.org/node/1001",
      license: "ODbL-1.0",
      confidence: 0.9,
    });
    expect(c.collectedAt).toBe(at);
    expect(c.rawTags?.phone).toContain("98450");
  });
  it("uses the centre of ways, and skips unnamed or unlocated elements", () => {
    const way = normalizeOsmElement(els[1]!, ["hospitals"], at)!;
    expect([way.lat, way.lon, way.providerId]).toEqual([15.8655, 74.5055, "way/2002"]);
    expect(way.phone).toBe("+918312400000");
    expect(way.confidence).toBe(0.65);
    expect(normalizeOsmElement(els[2]!, ["restaurants"], at)).toBeNull();
    expect(normalizeOsmElement(els[5]!, ["education"], at)).toBeNull();
    expect(normalizeOsmElement(els[0]!, ["hotels"], at)).toBeNull();
  });
  it("scores confidence as completeness, capped below 1", () => {
    expect(confidenceScore({ address: {} })).toBe(0.5);
    expect(confidenceScore({ address: { street: "x" }, phone: "1", openingHours: "24/7" })).toBe(
      0.9,
    );
  });
});
