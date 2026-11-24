import { describe, expect, it } from "vitest";
import { KALPIX_CATEGORIES } from "@kalpix/core";
import {
  buildOverpassQuery,
  CATEGORY_MAP,
  categoryOptions,
  classifyTags,
  loadCategoryMap,
} from "./categories";

const bbox = { south: 15.85, west: 74.49, north: 15.87, east: 74.51 };

describe("category mapping (config/category-tags.json)", () => {
  it("covers all 12 Kalpix industries, each with at least one OSM tag filter", () => {
    expect(KALPIX_CATEGORIES).toHaveLength(12);
    for (const c of KALPIX_CATEGORIES) {
      expect(CATEGORY_MAP.categories[c], c).toBeDefined();
      expect(CATEGORY_MAP.categories[c]!.osm.length).toBeGreaterThan(0);
    }
    expect(categoryOptions()).toHaveLength(12);
  });
  it("rejects a config with a missing category or an unsafe tag value", () => {
    const { hotels: _drop, ...rest } = CATEGORY_MAP.categories;
    void _drop;
    expect(() => loadCategoryMap({ version: 1, categories: rest })).toThrow(/missing category/);
    const bad = structuredClone(CATEGORY_MAP);
    bad.categories.hotels!.osm[0]!.values = ['hotel"];out;'];
    expect(() => loadCategoryMap(bad)).toThrow();
    const unknown = structuredClone(CATEGORY_MAP) as typeof CATEGORY_MAP;
    unknown.categories["casinos"] = { label: "x", osm: [{ key: "amenity", values: ["casino"] }] };
    expect(() => loadCategoryMap(unknown)).toThrow(/unknown category/);
  });
  it("maps restaurants and garages to the expected OSM tags", () => {
    const r = CATEGORY_MAP.categories.restaurants!.osm;
    expect(r).toContainEqual(expect.objectContaining({ key: "amenity" }));
    expect(r[0]!.values).toEqual(expect.arrayContaining(["restaurant", "cafe", "fast_food"]));
    expect(CATEGORY_MAP.categories.garages!.osm[0]!.values).toContain("car_repair");
    expect(CATEGORY_MAP.categories.real_estate!.osm[0]).toEqual({
      key: "office",
      values: ["estate_agent", "property_management"],
    });
  });
  it("builds a bounded, named-only Overpass query", () => {
    const q = buildOverpassQuery(["restaurants", "hospitals"], bbox, { timeoutSec: 30 });
    expect(q.startsWith("[out:json][timeout:30];")).toBe(true);
    expect(q).toContain(
      'nwr["amenity"~"^(restaurant|cafe|fast_food|food_court|ice_cream|bar|pub)$"]["name"](15.85,74.49,15.87,74.51);',
    );
    expect(q).toContain('nwr["healthcare"~"^(hospital)$"]["name"]');
    expect(q.trim().endsWith("out center tags;")).toBe(true);
    expect(() => buildOverpassQuery(["nope" as never], bbox)).toThrow(/Unknown category/);
  });
  it("classifies by config order and only into requested categories", () => {
    const tags = { amenity: "hospital", healthcare: "hospital" };
    expect(classifyTags(tags, ["hospitals", "clinics"])).toEqual({
      category: "hospitals",
      subcategory: "amenity=hospital",
    });
    expect(classifyTags({ shop: "car_repair" }, ["garages"])?.category).toBe("garages");
    expect(classifyTags({ shop: "car_repair" }, ["retail"])).toBeNull();
    expect(classifyTags({ amenity: "bench" }, [...KALPIX_CATEGORIES])).toBeNull();
  });
});
