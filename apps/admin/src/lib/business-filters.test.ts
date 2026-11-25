import { describe, expect, it } from "vitest";
import {
  businessOrderBy,
  businessWhere,
  filtersToQuery,
  parseBusinessFilters,
} from "./business-filters";

describe("business filters", () => {
  it("drops unknown or unsafe values", () => {
    expect(
      parseBusinessFilters({
        category: "casinos",
        website: "maybe",
        phone: "1",
        run: "x'; drop",
        q: " cafe ",
        research: "maybe",
        tier: "lukewarm",
        sort: "name; drop",
      }),
    ).toEqual({
      category: "",
      website: "",
      phone: "",
      q: "cafe",
      run: "",
      research: "",
      tier: "",
      sort: "",
    });
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
  it("filters on research status", () => {
    expect(businessWhere(parseBusinessFilters({ research: "never" })).AND).toEqual([
      { lastResearchedAt: null },
    ]);
    expect(businessWhere(parseBusinessFilters({ research: "researched" })).AND).toEqual([
      { lastResearchedAt: { not: null } },
    ]);
    expect(businessWhere(parseBusinessFilters({ research: "conflicts" })).AND).toEqual([
      { facts: { some: { verificationStatus: "conflicting" } } },
    ]);
  });
  it("filters on qualification tier, including never qualified", () => {
    expect(businessWhere(parseBusinessFilters({ tier: "hot" })).AND).toEqual([
      { latestTier: "hot" },
    ]);
    expect(businessWhere(parseBusinessFilters({ tier: "unqualified" })).AND).toEqual([
      { latestTier: null },
    ]);
  });
  it("sorts by score with unqualified last, else by last seen", () => {
    expect(businessOrderBy(parseBusinessFilters({ sort: "score" }))[0]).toEqual({
      latestScore: { sort: "desc", nulls: "last" },
    });
    expect(businessOrderBy(parseBusinessFilters({}))[0]).toEqual({ lastSeenAt: "desc" });
  });
  it("round-trips filters into a query string", () => {
    expect(filtersToQuery({ category: "hotels", website: "", q: "a b" }, { page: "2" })).toBe(
      "?category=hotels&q=a+b&page=2",
    );
    expect(filtersToQuery({})).toBe("");
  });
});
