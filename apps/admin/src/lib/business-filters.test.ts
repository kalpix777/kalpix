import { describe, expect, it } from "vitest";
import { businessWhere, filtersToQuery, parseBusinessFilters } from "./business-filters";

describe("business filters", () => {
  it("drops unknown or unsafe values", () => {
    expect(
      parseBusinessFilters({
        category: "casinos",
        website: "maybe",
        phone: "1",
        run: "x'; drop",
        q: " cafe ",
      }),
    ).toEqual({ category: "", website: "", phone: "", q: "cafe", run: "" });
  });
  it("builds a Prisma where for category, website and search", () => {
    const f = parseBusinessFilters({ category: "restaurants", website: "no", q: "udupi" });
    const w = businessWhere(f);
    expect(w.AND).toEqual(
      expect.arrayContaining([
        { category: "restaurants" },
        { hasWebsite: false },
        expect.objectContaining({ OR: expect.any(Array) }),
      ]),
    );
    expect(businessWhere(parseBusinessFilters({}))).toEqual({});
  });
  it("filters on phone presence", () => {
    expect(businessWhere(parseBusinessFilters({ phone: "yes" })).AND).toEqual([
      { phone: { not: null } },
    ]);
    expect(businessWhere(parseBusinessFilters({ phone: "no" })).AND).toEqual([{ phone: null }]);
  });
  it("round-trips filters into a query string", () => {
    expect(filtersToQuery({ category: "hotels", website: "", q: "a b" }, { page: "2" })).toBe(
      "?category=hotels&q=a+b&page=2",
    );
    expect(filtersToQuery({})).toBe("");
  });
});
