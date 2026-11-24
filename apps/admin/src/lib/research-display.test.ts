import { describe, expect, it } from "vitest";
import {
  describeScope,
  outcomeCounts,
  parseResearchPrefill,
  researchLinkForBusinessFilters,
  describeSignals,
  fieldLabel,
  groupFacts,
  researchProviderLabel,
  researchStatusLabel,
  selectableResearchProviders,
} from "./research-display";

describe("research display", () => {
  it("never offers the mock provider in production", () => {
    expect(selectableResearchProviders("production")).toEqual(["http"]);
    expect(selectableResearchProviders("development")).toEqual(["http", "mock"]);
  });

  it("labels providers, statuses and fields", () => {
    expect(researchProviderLabel("mock-research")).toContain("MOCK");
    expect(researchStatusLabel("blocked")).toContain("robots");
    expect(fieldLabel("social_facebook")).toBe("Facebook");
    expect(fieldLabel("unknown_field")).toBe("unknown_field");
  });

  it("describes signals in plain language without a score", () => {
    expect(describeSignals({ noWebsite: true })).toEqual(["No website listed for this business."]);
    const lines = describeSignals({
      noWebsite: false,
      httpStatus: 200,
      https: false,
      hasViewport: false,
      hasMetaDescription: false,
      responseTimeMs: 1530,
      pageBytes: 20480,
      copyrightYear: 2017,
      generator: "WordPress 5.2",
      tech: ["jQuery"],
      pagesFetched: 3,
    });
    expect(lines).toContain("Homepage answered HTTP 200.");
    expect(lines.some((l) => l.includes("Not secure"))).toBe(true);
    expect(lines.some((l) => l.includes("not mobile-friendly"))).toBe(true);
    expect(lines).toContain("Responded in 1.5 s.");
    expect(lines).toContain("Homepage size 20 KB.");
    expect(lines).toContain("Footer copyright year: 2017.");
    expect(lines).toContain("Built with: WordPress 5.2, jQuery.");
    expect(lines).toContain("3 pages read.");
    expect(lines.join(" ")).not.toMatch(/score/i);
  });

  it("explains broken and blocked sites", () => {
    expect(describeSignals({ noWebsite: false, broken: "dns" })[0]).toContain("DNS");
    expect(describeSignals({ noWebsite: false, blockedByRobots: true })[0]).toContain("robots.txt");
    expect(describeSignals(null)).toEqual([]);
    expect(describeSignals("junk")).toEqual([]);
  });

  it("groups facts by field in display order, conflicts first", () => {
    const g = groupFacts([
      { field: "page_title", value: "T", verificationStatus: "unverified" },
      { field: "phone", value: "+91 2", verificationStatus: "unverified" },
      { field: "phone", value: "+91 1", verificationStatus: "conflicting" },
      { field: "email", value: "a@b.in", verificationStatus: "unverified" },
    ]);
    expect(g.map((x) => x.field)).toEqual(["phone", "email", "page_title"]);
    expect(g[0]?.facts[0]?.verificationStatus).toBe("conflicting");
  });

  it("describes run scopes", () => {
    expect(
      describeScope({
        scopeType: "businesses",
        businessIds: ["a"],
        discoveryRunId: null,
        filter: null,
      }),
    ).toBe("1 selected business");
    expect(
      describeScope(
        { scopeType: "discovery_run", businessIds: [], discoveryRunId: "abc", filter: null },
        { discoveryRunLabel: () => "Tilakwadi" },
      ),
    ).toBe("Discovery run: Tilakwadi");
    expect(
      describeScope({
        scopeType: "filter",
        businessIds: [],
        discoveryRunId: null,
        filter: { category: "restaurants", hasWebsite: true, staleAfterDays: 30, limit: 100 },
      }),
    ).toBe("Filter: restaurants, has website, not researched in 30 days, limit 100");
  });
});

describe("research prefill and links", () => {
  const isCat = (c: string) => c === "restaurants" || c === "hotels";
  const RUN = "0b6f3f0e-6a3c-4c39-9a51-5d1c4f1c2b7a";

  it("parses a safe prefill and drops junk", () => {
    expect(
      parseResearchPrefill(
        { category: "restaurants", website: "yes", staleAfterDays: "30", limit: "50" },
        isCat,
      ),
    ).toEqual({
      scope: "filter",
      discoveryRunId: "",
      category: "restaurants",
      website: "yes",
      staleAfterDays: "30",
      limit: "50",
    });
    expect(
      parseResearchPrefill(
        { scope: "discovery_run", discoveryRunId: "x';", category: "casinos", limit: "9999" },
        isCat,
      ),
    ).toEqual({
      scope: "filter",
      discoveryRunId: "",
      category: "",
      website: "",
      staleAfterDays: "",
      limit: "100",
    });
    expect(parseResearchPrefill({ scope: "discovery_run", discoveryRunId: RUN }, isCat).scope).toBe(
      "discovery_run",
    );
  });

  it("builds the Research these link from business filters", () => {
    expect(researchLinkForBusinessFilters({ category: "hotels", website: "yes" })).toEqual({
      href: "/research?scope=filter&category=hotels&website=yes",
      dropped: [],
    });
    expect(researchLinkForBusinessFilters({ research: "never" }).href).toBe(
      "/research?scope=filter&staleAfterDays=3650",
    );
    const r = researchLinkForBusinessFilters({
      run: RUN,
      category: "hotels",
      q: "x",
      phone: "yes",
    });
    expect(r.href).toBe(`/research?scope=discovery_run&discoveryRunId=${RUN}`);
    expect(r.dropped).toEqual(["category", "search", "phone"]);
    expect(researchLinkForBusinessFilters({ research: "conflicts" }).dropped).toEqual([
      "research status",
    ]);
  });

  it("lists outcome counts in display order", () => {
    expect(
      outcomeCounts({
        okCount: 3,
        noWebsiteCount: 2,
        brokenCount: 1,
        blockedCount: 0,
        errorCount: 4,
      }).map((o) => `${o.outcome}:${o.count}`),
    ).toEqual(["ok:3", "no_website:2", "broken:1", "blocked:0", "error:4"]);
  });
});
