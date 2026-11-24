import { describe, expect, it } from "vitest";
import {
  detectConflicts,
  factOrigin,
  parseResearchFilter,
  RESEARCH_MAX_BUSINESSES_PER_RUN,
} from "./research";

const f = (field: string, normalizedValue: string, sourceType: string) => ({
  field,
  normalizedValue,
  sourceType,
});

describe("detectConflicts", () => {
  it("flags a field when listing and website values share nothing", () => {
    const c = detectConflicts([
      f("phone", "+918312461234", "osm"),
      f("phone", "+918312469999", "jsonld"),
      f("email", "a@x.in", "osm"),
      f("email", "a@x.in", "html"),
    ]);
    expect([...c]).toEqual(["phone"]);
  });
  it("one shared value means agreement; several website values never conflict among themselves", () => {
    expect(
      detectConflicts([
        f("phone", "+911", "osm"),
        f("phone", "+911", "html"),
        f("phone", "+912", "jsonld"),
      ]).size,
    ).toBe(0);
    expect(detectConflicts([f("phone", "+911", "html"), f("phone", "+912", "jsonld")]).size).toBe(
      0,
    );
  });
  it("ignores fields outside CONFLICT_FIELDS and single-origin fields", () => {
    expect(detectConflicts([f("name", "a", "osm"), f("name", "b", "jsonld")]).size).toBe(0);
    expect(
      detectConflicts([
        f("postcode", "590006", "listing"),
        f("postcode", "590001", "microdata"),
      ]).has("postcode"),
    ).toBe(true);
  });
  it("maps source types to origins", () => {
    expect(factOrigin("osm")).toBe("listing");
    expect(factOrigin("listing")).toBe("listing");
    expect(factOrigin("mock")).toBe("website");
    expect(factOrigin("jsonld")).toBe("website");
  });
});

describe("parseResearchFilter", () => {
  it("accepts known keys and caps the limit", () => {
    expect(
      parseResearchFilter({ category: " restaurants ", hasWebsite: true, limit: 10_000 }),
    ).toEqual({
      category: "restaurants",
      hasWebsite: true,
      limit: RESEARCH_MAX_BUSINESSES_PER_RUN,
    });
  });
  it("rejects unknown keys and bad types", () => {
    expect(() => parseResearchFilter({ sql: "1=1" })).toThrow(/Unknown/);
    expect(() => parseResearchFilter({ limit: -1 })).toThrow(/positive/);
    expect(() => parseResearchFilter({ hasWebsite: "yes" })).toThrow(/boolean/);
    expect(() => parseResearchFilter(null)).toThrow(/object/);
  });
});
