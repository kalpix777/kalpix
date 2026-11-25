import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseStructuredOutput, tokenCostMinor } from "./model";
import {
  buildQualificationPrompt,
  parseQualificationConfig,
  parseQualificationFilter,
  qualificationAiOutputSchema,
  sanitizeAiOutput,
  scoreBusiness,
  type ScoringFact,
  type ScoringInput,
} from "./qualification";

const config = parseQualificationConfig({});
const NOW = new Date("2026-11-24T00:00:00Z");
const noEvidence = { status: "no_evidence" as const, hints: [] };

function f(
  id: string,
  field: string,
  value: string,
  status = "unverified",
  sourceType = "osm",
): ScoringFact {
  return { id, field, normalizedValue: value, sourceType, verificationStatus: status };
}
function input(p: Partial<ScoringInput>): ScoringInput {
  return {
    business: { id: "b1", name: "Hotel Sagar", category: "restaurants", source: "openstreetmap" },
    facts: [],
    latestResearch: null,
    operating: noEvidence,
    now: NOW,
    ...p,
  };
}
const research = (signals: Record<string, unknown>, status = "ok") => ({
  id: "r1",
  status,
  signals: { noWebsite: false, ...signals },
});

describe("config", () => {
  it("has defaults that add up to 100 and validates overrides", () => {
    expect(config.website.max + config.contact.max + config.categoryMax).toBe(100);
    expect(config.thresholds).toEqual({ hot: 70, warm: 45 });
    expect(
      parseQualificationConfig({ blockedCategories: ["hospitals"] }).blockedCategories,
    ).toEqual(["hospitals"]);
    expect(() => parseQualificationConfig({ thresholds: { hot: 40, warm: 50 } })).toThrow(/warm/);
    expect(() => parseQualificationConfig({ website: { noWebsite: 500 } })).toThrow();
  });
});

describe("scoreBusiness", () => {
  it("no website + verified phone + strong category = hot, every reason cites facts", () => {
    const s = scoreBusiness(
      input({
        facts: [
          f("p1", "phone", "+919845012345", "verified"),
          f("p2", "phone", "+919845012345", "verified", "jsonld"),
        ],
      }),
      config,
    );
    expect(s).toMatchObject({ score: 85, tier: "hot", disqualifiedReason: null, mock: false });
    expect(s.components).toEqual({ website: 50, contact: 20, category: 15 });
    const phone = s.reasons.find((r) => r.code === "verified_phone")!;
    expect(phone.factIds).toEqual(["p1", "p2"]);
    expect(s.reasons.find((r) => r.code === "no_website")!.text).toMatch(/No website/);
    expect(s.reasons.every((r) => typeof r.text === "string" && Array.isArray(r.factIds))).toBe(
      true,
    );
  });

  it("scores an outdated site: no https, no viewport, old copyright, old builder, missing description", () => {
    const s = scoreBusiness(
      input({
        facts: [
          f("w1", "website", "http://sagar.in/", "verified"),
          f("p1", "phone", "+919845012345"),
        ],
        latestResearch: research({
          https: false,
          hasViewport: false,
          copyrightYear: 2019,
          tech: ["Weebly"],
          hasTitle: true,
          hasMetaDescription: false,
          responseTimeMs: 6000,
        }),
      }),
      config,
    );
    expect(s.components.website).toBe(12 + 12 + 8 + 8 + 5 + 5);
    expect(
      s.reasons
        .filter((r) => r.kind === "opportunity")
        .every((r) => r.factIds.includes("w1") && r.researchId === "r1"),
    ).toBe(true);
    expect(s).toMatchObject({ score: 75, tier: "hot" }); // 50 (capped) + 10 + 15
  });

  it("modern site with only an unverified email is cold", () => {
    const s = scoreBusiness(
      input({
        facts: [
          f("w1", "website", "https://sagar.in/", "verified"),
          f("e1", "email", "hello@sagar.in", "unverified", "jsonld"),
        ],
        latestResearch: research({
          https: true,
          hasViewport: true,
          hasTitle: true,
          hasMetaDescription: true,
          copyrightYear: 2026,
          tech: ["WordPress"],
        }),
      }),
      config,
    );
    expect(s).toMatchObject({ tier: "cold", score: 4 + 15 });
    expect(s.reasons.some((r) => r.code === "website_ok")).toBe(true);
  });

  it("broken website counts as opportunity; social-profile-only too", () => {
    expect(
      scoreBusiness(
        input({
          facts: [f("p", "phone", "+919845012345")],
          latestResearch: research({ broken: "dns", brokenDetail: "domain not found" }, "broken"),
        }),
        config,
      ).components.website,
    ).toBe(45);
    expect(
      scoreBusiness(
        input({
          facts: [f("p", "phone", "+919845012345")],
          latestResearch: research(
            { noWebsite: true, socialProfileOnly: "facebook.com" },
            "no_website",
          ),
        }),
        config,
      ).components.website,
    ).toBe(45);
  });

  it("does not guess when a listed website was never researched or is robots-blocked", () => {
    const a = scoreBusiness(
      input({ facts: [f("w", "website", "https://x.in/"), f("p", "phone", "+919845012345")] }),
      config,
    );
    expect(a.components.website).toBe(0);
    expect(a.reasons.find((r) => r.code === "website_not_researched")!.factIds).toEqual(["w"]);
    const b = scoreBusiness(
      input({
        facts: [f("p", "phone", "+919845012345")],
        latestResearch: research({ blockedByRobots: true }, "blocked"),
      }),
      config,
    );
    expect(b.reasons.find((r) => r.code === "website_unchecked")!.text).toMatch(/robots/);
  });

  it("ignores invalid contacts and caps contactability", () => {
    const s = scoreBusiness(
      input({
        facts: [
          f("p1", "phone", "+919845012345", "verified"),
          f("w1", "whatsapp", "+919845012345", "verified"),
          f("e1", "email", "hello@sagar.in", "verified"),
          f("bad", "phone", "+910000000000", "invalid"),
        ],
      }),
      config,
    );
    expect(s.components.contact).toBe(35);
    expect(s.reasons.find((r) => r.code === "invalid_contacts")!.factIds).toEqual(["bad"]);
  });

  describe("tiering", () => {
    const cfg = parseQualificationConfig({ thresholds: { hot: 70, warm: 45 } });
    it.each([
      [["+919845012345", "verified"], "restaurants", 85, "hot"],
      [["+919845012345", "unverified"], "manufacturers", 69, "warm"],
    ] as const)("%j %s -> %i %s", ([num, st], category, score, tier) => {
      const s = scoreBusiness(
        input({ business: { id: "b", name: "X", category }, facts: [f("p", "phone", num, st)] }),
        cfg,
      );
      expect(s).toMatchObject({ score, tier });
    });
    it("boundary: score equal to threshold is that tier", () => {
      const c = parseQualificationConfig({ thresholds: { hot: 85, warm: 45 } });
      expect(
        scoreBusiness(input({ facts: [f("p", "phone", "+919845012345", "verified")] }), c).tier,
      ).toBe("hot");
    });
  });

  describe("disqualification", () => {
    const phone = [f("p", "phone", "+919845012345", "verified")];
    it("closed / disused", () => {
      const s = scoreBusiness(
        input({
          facts: phone,
          operating: {
            status: "closed",
            hints: [
              {
                code: "osm_lifecycle_tag",
                detail: "OSM tag disused:shop=bakery",
                strength: "strong",
              },
            ],
          },
        }),
        config,
      );
      expect(s).toMatchObject({ tier: "disqualified", disqualifiedReason: "closed" });
      expect(s.score).toBeGreaterThan(0); // the rules score is still recorded
      expect(s.reasons.find((r) => r.code === "dq_closed")!.text).toMatch(/disused:shop/);
    });
    it("possibly closed is only a note", () => {
      const s = scoreBusiness(
        input({
          facts: phone,
          operating: {
            status: "possibly_closed",
            hints: [{ code: "website_gone", detail: "Website gone", strength: "weak" }],
          },
        }),
        config,
      );
      expect(s.tier).toBe("hot");
      expect(s.reasons.some((r) => r.code === "possibly_closed")).toBe(true);
    });
    it("no contact channel (invalid ones do not count)", () => {
      const s = scoreBusiness(
        input({ facts: [f("bad", "phone", "+910000000000", "invalid")] }),
        config,
      );
      expect(s).toMatchObject({ tier: "disqualified", disqualifiedReason: "no_contact_channel" });
      expect(s.reasons.find((r) => r.code === "dq_no_contact_channel")!.factIds).toEqual(["bad"]);
    });
    it("duplicate", () => {
      expect(
        scoreBusiness(input({ facts: phone, duplicateOfId: "older" }), config).disqualifiedReason,
      ).toBe("duplicate");
    });
    it("owner-blocklisted category", () => {
      const c = parseQualificationConfig({ blockedCategories: ["restaurants"] });
      expect(scoreBusiness(input({ facts: phone }), c).disqualifiedReason).toBe("blocked_category");
    });
  });

  it("labels MOCK inputs", () => {
    const s = scoreBusiness(
      input({
        business: { id: "b", name: "MOCK Restaurant 1", category: "restaurants", source: "mock" },
        facts: [f("m", "phone", "+919001234567", "unverified", "mock")],
      }),
      config,
    );
    expect(s.mock).toBe(true);
    expect(s.reasons.find((r) => r.code === "mock_data")!.text).toMatch(/MOCK/);
  });
});

describe("AI output schema", () => {
  const good = {
    summary: "Busy restaurant with no website.",
    pitchAngle: "Offer a simple menu site.",
    riskFlags: [{ code: "contact_unverified", text: "Email not confirmed", factIds: ["e1"] }],
  };
  it("accepts valid output and defaults riskFlags", () => {
    expect(qualificationAiOutputSchema.parse(good).riskFlags).toHaveLength(1);
    expect(qualificationAiOutputSchema.parse({ summary: "a", pitchAngle: "b" }).riskFlags).toEqual(
      [],
    );
  });
  it("parses fenced JSON and prose-wrapped JSON", () => {
    expect(
      parseStructuredOutput(
        "```json\n" + JSON.stringify(good) + "\n```",
        qualificationAiOutputSchema,
      ).ok,
    ).toBe(true);
    expect(
      parseStructuredOutput(
        "Sure! " + JSON.stringify(good) + " Hope it helps",
        qualificationAiOutputSchema,
      ).ok,
    ).toBe(true);
  });
  it.each([
    ["not json at all", "malformed_output"],
    ["{summary: 'x'", "malformed_output"],
    ['{"summary": "x"}', "schema_mismatch"],
    [JSON.stringify({ ...good, summary: "x".repeat(601) }), "schema_mismatch"],
    [JSON.stringify({ ...good, riskFlags: [{ code: "made_up", text: "x" }] }), "schema_mismatch"],
    [JSON.stringify({ ...good, summary: "   " }), "schema_mismatch"],
  ])("rejects %s", (text, code) => {
    const r = parseStructuredOutput(text, qualificationAiOutputSchema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(code);
  });
  it("drops fact ids the model was not given", () => {
    const out = qualificationAiOutputSchema.parse({
      ...good,
      riskFlags: [{ code: "other", text: "x", factIds: ["e1", "invented"] }],
    });
    const s = sanitizeAiOutput(out, new Set(["e1"]));
    expect(s.output.riskFlags[0]!.factIds).toEqual(["e1"]);
    expect(s.droppedFactIds).toBe(1);
  });
  it("generic schema parse never throws", () => {
    expect(parseStructuredOutput("[1,2]", z.object({ a: z.string() })).ok).toBe(false);
  });
});

describe("buildQualificationPrompt", () => {
  it("masks contact values and carries prompt version, score and fact ids", () => {
    const score = scoreBusiness(
      input({ facts: [f("p1", "phone", "+919845012345", "verified")] }),
      config,
    );
    const { system, prompt } = buildQualificationPrompt({
      business: { name: "Hotel Sagar", category: "restaurants", city: "Belagavi" },
      facts: [
        {
          id: "p1",
          field: "phone",
          value: "+91 98450 12345",
          sourceType: "osm",
          verificationStatus: "verified",
        },
        {
          id: "e1",
          field: "email",
          value: "owner.name@gmail.com",
          sourceType: "jsonld",
          verificationStatus: "unverified",
        },
        {
          id: "h1",
          field: "opening_hours",
          value: "Mo-Sa 09:00-18:00",
          sourceType: "osm",
          verificationStatus: "unverified",
        },
      ],
      signals: { noWebsite: true, requestedUrl: "https://secret.example/" },
      researchStatus: "no_website",
      score,
      promptVersion: "qual-v1",
    });
    expect(prompt).not.toContain("98450");
    expect(prompt).not.toContain("owner.name");
    expect(prompt).not.toContain("requestedUrl");
    expect(prompt).toContain("Mo-Sa 09:00-18:00");
    expect(prompt).toContain('"p1"');
    expect(JSON.parse(prompt)).toMatchObject({
      promptVersion: "qual-v1",
      rulesScore: { score: 85, tier: "hot" },
    });
    expect(system).toMatch(/ONLY the facts/);
  });
});

describe("parseQualificationFilter / tokenCostMinor", () => {
  it("validates filters", () => {
    expect(parseQualificationFilter({ category: "restaurants", tier: "hot", limit: 5000 })).toEqual(
      { category: "restaurants", tier: "hot", limit: 1000 },
    );
    expect(() => parseQualificationFilter({ tier: "lukewarm" })).toThrow(/tier/);
    expect(() => parseQualificationFilter({ foo: 1 })).toThrow(/Unknown/);
  });
  it("costs nothing without configured rates", () => {
    expect(tokenCostMinor({ inputTokens: 1000, outputTokens: 500 })).toBe(0);
    expect(
      tokenCostMinor({ inputTokens: 1_000_000, outputTokens: 0 }, { inputPerMillionMinor: 2500 }),
    ).toBe(2500);
  });
});
