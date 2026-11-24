import {
  fail,
  ok,
  type ProviderDescriptor,
  type ProviderHealth,
  type ResearchFact,
  type Result,
  type WebsiteResearchInput,
  type WebsiteResearchProvider,
  type WebsiteResearchResult,
} from "@kalpix/core";
import { summarize } from "./http-research";

/**
 * Deterministic offline research provider for tests and CI (RESEARCH_PROVIDER=mock). Makes no
 * request; every fact has sourceType "mock" and a "Test fixture" usage restriction, and every
 * value says MOCK. Refused when APP_ENV=production (see research-factory.ts and the worker).
 * - no website            -> no_website
 * - website containing "broken" -> broken (http_5xx)
 * - otherwise             -> ok with a phone, email, Facebook page and title
 */
export const MOCK_RESEARCH_DESCRIPTOR: ProviderDescriptor = {
  id: "mock-research",
  name: "Mock research (tests only)",
  category: "research",
  costTier: "free",
  requiredSecrets: [],
  commercialUseVerified: true,
};

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

export class MockResearchProvider implements WebsiteResearchProvider {
  readonly descriptor = MOCK_RESEARCH_DESCRIPTOR;
  requestsMade = 0;
  /** Business ids researched, in order (tests check resumability). */
  readonly calls: string[] = [];
  /** Test hook: these business ids fail once with ok:false. */
  failOnce = new Set<string>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async healthCheck(): Promise<ProviderHealth> {
    return { status: "connected", checkedAt: new Date(), detail: "mock" };
  }

  async research(input: WebsiteResearchInput): Promise<Result<WebsiteResearchResult>> {
    this.calls.push(input.businessId);
    if (this.failOnce.delete(input.businessId))
      return fail(`MOCK research failure for ${input.businessId}`);
    if (!input.website)
      return ok({
        status: "no_website",
        facts: [],
        signals: { noWebsite: true },
        requests: 0,
        summary: "No website listed. (MOCK)",
      });
    this.requestsMade++;
    if (input.website.includes("broken")) {
      const signals = {
        noWebsite: false,
        requestedUrl: input.website,
        httpStatus: 500,
        broken: "http_5xx" as const,
        brokenDetail: "MOCK HTTP 500",
      };
      return ok({
        status: "broken",
        facts: [],
        signals,
        requests: 1,
        summary: summarize("broken", signals, []),
      });
    }
    const collectedAt = this.now();
    const slug = (input.website.split("/").pop() || "site")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "");
    const phone = `+91900${String(hash(input.website) % 10_000_000).padStart(7, "0")}`;
    const base = {
      sourceUrl: input.website,
      collectedAt,
      sourceType: "mock" as const,
      confidence: 0.5,
      verificationStatus: "unverified" as const,
      usageRestriction: "Test fixture. Not real data.",
    };
    const facts: ResearchFact[] = [
      { ...base, field: "phone", value: phone, normalizedValue: phone },
      {
        ...base,
        field: "email",
        value: `mock-${slug}@mock.invalid`,
        normalizedValue: `mock-${slug}@mock.invalid`,
      },
      {
        ...base,
        field: "social_facebook",
        value: `https://facebook.com/mock-${slug}`,
        normalizedValue: `https://facebook.com/mock-${slug}`,
      },
      {
        ...base,
        field: "page_title",
        value: `MOCK ${input.name}`,
        normalizedValue: `mock ${input.name.toLowerCase()}`,
      },
    ];
    const signals = {
      noWebsite: false,
      requestedUrl: input.website,
      finalUrl: input.website,
      httpStatus: 200,
      https: input.website.startsWith("https:"),
      hasViewport: true,
      hasTitle: true,
      hasMetaDescription: false,
      pagesFetched: 1,
      tech: ["MOCK"],
    };
    return ok({
      status: "ok",
      facts,
      signals,
      requests: 1,
      summary: `${summarize("ok", signals, facts)} (MOCK)`,
    });
  }
}
