import { describe, expect, it } from "vitest";
import {
  contactChannels,
  describeQualificationScope,
  evidenceSummary,
  leadsQuery,
  leadsWhere,
  parseAiRisks,
  parseComponents,
  parseLeadsFilters,
  parseReasons,
  selectableAiKinds,
  tierCounts,
  topReason,
} from "./qualification-display";

const isCat = (c: string) => c === "restaurants" || c === "clinics";

describe("qualification display", () => {
  it("parses stored reasons defensively", () => {
    const r = parseReasons([
      { code: "no_website", kind: "opportunity", points: 50, text: "No website", factIds: ["a"] },
      { code: 3, text: "bad" },
      null,
      { code: "x", text: "y", factIds: ["ok", 4], points: "9" },
    ]);
    expect(r).toHaveLength(2);
    expect(r[1]).toEqual({ code: "x", kind: "note", points: 0, text: "y", factIds: ["ok"] });
    expect(parseReasons("nope")).toEqual([]);
  });

  it("picks the top reason: disqualification first, else highest-scoring opportunity/contact", () => {
    const reasons = parseReasons([
      { code: "category_fit", kind: "category", points: 15, text: "cat", factIds: [] },
      { code: "phone", kind: "contact", points: 10, text: "phone", factIds: [] },
      { code: "no_website", kind: "opportunity", points: 50, text: "none", factIds: [] },
      { code: "dq_closed", kind: "disqualification", points: 0, text: "closed", factIds: [] },
    ]);
    expect(topReason(reasons, "hot")?.code).toBe("no_website");
    expect(topReason(reasons, "disqualified")?.code).toBe("dq_closed");
    expect(topReason([], "cold")).toBeNull();
  });

  it("derives contact channels from reason codes", () => {
    const reasons = parseReasons([
      { code: "verified_phone", kind: "contact", points: 20, text: "", factIds: [] },
      { code: "email", kind: "contact", points: 4, text: "", factIds: [] },
    ]);
    expect(contactChannels(reasons)).toEqual([
      { channel: "phone", verified: true },
      { channel: "email", verified: false },
    ]);
  });

  it("reads components, AI risks and tier counts", () => {
    expect(parseComponents({ website: 40, contact: "x" })).toEqual({
      website: 40,
      contact: 0,
      category: 0,
    });
    expect(parseAiRisks([{ code: "sparse_data", text: "t", factIds: ["f1"] }, { x: 1 }])).toEqual([
      { code: "sparse_data", text: "t", factIds: ["f1"] },
    ]);
    expect(
      tierCounts({ hotCount: 1, warmCount: 2, coldCount: 3, disqualifiedCount: 4 }).map(
        (t) => t.count,
      ),
    ).toEqual([1, 2, 3, 4]);
  });

  it("summarises verification evidence without dumping JSON", () => {
    expect(
      evidenceSummary({
        domain: "example.in",
        mx: "ok",
        independentSources: ["a", "b"],
        domainMatchesWebsite: true,
      }),
    ).toBe("2 independent sources · domain example.in · MX found · matches website domain");
    expect(evidenceSummary({ previous: { status: "unverified" } })).toBe(
      "was unverified before override",
    );
    expect(evidenceSummary(null)).toBe("");
  });

  it("only offers ready AI providers, never MOCK in production", () => {
    const st = [
      { kind: "mock" as const, ready: true },
      { kind: "ollama" as const, ready: false },
      { kind: "gemini" as const, ready: true },
    ];
    expect(selectableAiKinds(st, "development")).toEqual(["mock", "gemini"]);
    expect(selectableAiKinds(st, "production")).toEqual(["gemini"]);
  });

  it("parses lead filters: default excludes disqualified, unknown values fall back", () => {
    expect(parseLeadsFilters({}, isCat)).toEqual({ tier: "qualified", category: "" });
    expect(parseLeadsFilters({ tier: "all", category: "clinics" }, isCat)).toEqual({
      tier: "",
      category: "clinics",
    });
    expect(parseLeadsFilters({ tier: "boiling", category: "casinos" }, isCat)).toEqual({
      tier: "qualified",
      category: "",
    });
    expect(leadsWhere({ tier: "qualified", category: "" })).toEqual({
      latestTier: { in: ["hot", "warm", "cold"] },
    });
    expect(leadsWhere({ tier: "", category: "clinics" })).toEqual({
      latestTier: { not: null },
      category: "clinics",
    });
    expect(leadsWhere({ tier: "hot", category: "" })).toEqual({ latestTier: "hot" });
    expect(leadsQuery({ tier: "", category: "clinics" }, { page: "2" })).toBe(
      "?tier=all&category=clinics&page=2",
    );
    expect(leadsQuery({ tier: "qualified", category: "" })).toBe("");
  });

  it("describes run scopes", () => {
    const base = { businessIds: [], discoveryRunId: null, researchRunId: null, filter: null };
    expect(
      describeQualificationScope({
        ...base,
        scopeType: "research_run",
        researchRunId: "abcdef1234",
      }),
    ).toBe("Research run: abcdef12");
    expect(
      describeQualificationScope({
        ...base,
        scopeType: "filter",
        filter: { category: "clinics", tier: "warm", staleAfterDays: 7, limit: 50 },
      }),
    ).toBe("Filter: clinics, currently warm, not qualified in 7 days, limit 50");
    expect(
      describeQualificationScope({ ...base, scopeType: "businesses", businessIds: ["a"] }),
    ).toBe("1 selected business");
  });
});
