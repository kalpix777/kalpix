import { describe, expect, it } from "vitest";
import { integrationStatus, loadEnv } from "./env";

const base = { DATABASE_URL: "postgresql://kalpix:pw@localhost:5432/kalpix_dev" };

describe("loadEnv", () => {
  it("accepts a minimal development config and applies defaults", () => {
    const env = loadEnv(base);
    expect(env.APP_ENV).toBe("development");
    expect(env.APP_NAME).toBe("Kalpix");
  });

  it("treats empty keys as not configured", () => {
    const env = loadEnv({ ...base, OPENAI_API_KEY: "" });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(integrationStatus(env).OPENAI_API_KEY).toBe("missing");
  });

  it("rejects a non-PostgreSQL database URL", () => {
    expect(() => loadEnv({ DATABASE_URL: "mysql://x@localhost/db" })).toThrow(/PostgreSQL/);
  });

  it("blocks unsafe production settings", () => {
    expect(() =>
      loadEnv({
        APP_ENV: "production",
        DATABASE_URL: "postgresql://u:change-me@db/prod",
        RAZORPAY_KEY_ID: "rzp_test_123",
      }),
    ).toThrow(/AUTH_SECRET[\s\S]*DATABASE_URL[\s\S]*RAZORPAY_KEY_ID/);
  });

  it("never exposes secret values in the status report", () => {
    const env = loadEnv({ ...base, GEMINI_API_KEY: "super-secret" });
    expect(JSON.stringify(integrationStatus(env))).not.toContain("super-secret");
  });

  it("applies Phase 3 discovery and worker defaults", () => {
    const env = loadEnv(base);
    expect(env.DISCOVERY_PROVIDER).toBe("overpass");
    expect(env.DISCOVERY_MAX_BBOX_DEG2).toBe(0.25);
    expect(env.NOMINATIM_COUNTRY_CODES).toBe("in");
    expect(env.WORKER_POLL_INTERVAL_MS).toBe(5000);
    const blank = loadEnv({ ...base, DISCOVERY_PROVIDER: "", WORKER_POLL_INTERVAL_MS: "" });
    expect(blank.DISCOVERY_PROVIDER).toBe("overpass");
    expect(blank.WORKER_POLL_INTERVAL_MS).toBe(5000);
  });

  it("parses and validates Phase 3 discovery settings", () => {
    const env = loadEnv({
      ...base,
      DISCOVERY_PROVIDER: "google_places",
      DISCOVERY_MAX_BBOX_DEG2: "0.05",
      NOMINATIM_COUNTRY_CODES: "IN,NP",
      WORKER_POLL_INTERVAL_MS: "2000",
    });
    expect(env.DISCOVERY_PROVIDER).toBe("google_places");
    expect(env.DISCOVERY_MAX_BBOX_DEG2).toBe(0.05);
    expect(env.NOMINATIM_COUNTRY_CODES).toBe("in,np");
    expect(env.WORKER_POLL_INTERVAL_MS).toBe(2000);
    expect(loadEnv({ ...base, DISCOVERY_PROVIDER: "osm" }).DISCOVERY_PROVIDER).toBe("overpass");
    expect(() => loadEnv({ ...base, DISCOVERY_PROVIDER: "bing" })).toThrow(/DISCOVERY_PROVIDER/);
    expect(() => loadEnv({ ...base, DISCOVERY_MAX_BBOX_DEG2: "-1" })).toThrow(/DISCOVERY_MAX_BBOX/);
    expect(() => loadEnv({ ...base, NOMINATIM_COUNTRY_CODES: "india" })).toThrow(/NOMINATIM/);
    expect(() => loadEnv({ ...base, WORKER_POLL_INTERVAL_MS: "10" })).toThrow(/WORKER_POLL/);
  });

  it("refuses the mock discovery provider in production", () => {
    expect(() =>
      loadEnv({
        APP_ENV: "production",
        DATABASE_URL: "postgresql://u:pw@db/prod",
        AUTH_SECRET: "x".repeat(40),
        DISCOVERY_PROVIDER: "mock",
      }),
    ).toThrow(/mock is not allowed/);
  });

  it("applies Phase 4 research defaults", () => {
    const env = loadEnv(base);
    expect(env.RESEARCH_PROVIDER).toBe("http");
    expect(env.RESEARCH_MAX_PAGES).toBe(5);
    expect(env.RESEARCH_HOST_DELAY_MS).toBe(2000);
    expect(env.RESEARCH_USER_AGENT_CONTACT).toBeUndefined();
    const blank = loadEnv({
      ...base,
      RESEARCH_PROVIDER: "",
      RESEARCH_MAX_PAGES: " ",
      RESEARCH_HOST_DELAY_MS: "",
      RESEARCH_USER_AGENT_CONTACT: "",
    });
    expect(blank.RESEARCH_PROVIDER).toBe("http");
    expect(blank.RESEARCH_MAX_PAGES).toBe(5);
    expect(blank.RESEARCH_USER_AGENT_CONTACT).toBeUndefined();
  });

  it("parses and validates Phase 4 research settings", () => {
    const env = loadEnv({
      ...base,
      RESEARCH_PROVIDER: " MOCK ",
      RESEARCH_MAX_PAGES: "3",
      RESEARCH_HOST_DELAY_MS: "5000",
      RESEARCH_USER_AGENT_CONTACT: "ops@kalpix.in",
    });
    expect(env).toMatchObject({
      RESEARCH_PROVIDER: "mock",
      RESEARCH_MAX_PAGES: 3,
      RESEARCH_HOST_DELAY_MS: 5000,
      RESEARCH_USER_AGENT_CONTACT: "ops@kalpix.in",
    });
    expect(
      loadEnv({ ...base, RESEARCH_USER_AGENT_CONTACT: "https://kalpix.in/bot" })
        .RESEARCH_USER_AGENT_CONTACT,
    ).toBe("https://kalpix.in/bot");
    expect(() => loadEnv({ ...base, RESEARCH_PROVIDER: "firecrawl" })).toThrow(/RESEARCH_PROVIDER/);
    expect(() => loadEnv({ ...base, RESEARCH_MAX_PAGES: "0" })).toThrow(/RESEARCH_MAX_PAGES/);
    expect(() => loadEnv({ ...base, RESEARCH_MAX_PAGES: "50" })).toThrow(/RESEARCH_MAX_PAGES/);
    expect(() => loadEnv({ ...base, RESEARCH_HOST_DELAY_MS: "500" })).toThrow(/at least 2000/);
    expect(() => loadEnv({ ...base, RESEARCH_USER_AGENT_CONTACT: "call me" })).toThrow(
      /RESEARCH_USER_AGENT_CONTACT/,
    );
  });

  it("refuses mock research and an anonymous research User-Agent in production", () => {
    const prod = {
      APP_ENV: "production",
      DATABASE_URL: "postgresql://u:pw@db/prod",
      AUTH_SECRET: "x".repeat(40),
    };
    expect(() =>
      loadEnv({ ...prod, RESEARCH_PROVIDER: "mock", RESEARCH_USER_AGENT_CONTACT: "a@b.in" }),
    ).toThrow(/RESEARCH_PROVIDER=mock is not allowed/);
    expect(() => loadEnv(prod)).toThrow(/RESEARCH_USER_AGENT_CONTACT is required/);
    expect(
      loadEnv({ ...prod, RESEARCH_USER_AGENT_CONTACT: "ops@kalpix.in" }).RESEARCH_PROVIDER,
    ).toBe("http");
  });

  it("applies Phase 5 qualification defaults (AI off, rules only)", () => {
    const env = loadEnv({ ...base, OLLAMA_BASE_URL: "", QUALIFICATION_AI_PROVIDER: "" });
    expect(env.QUALIFICATION_AI_PROVIDER).toBe("none");
    expect(env.QUALIFICATION_PROMPT_VERSION).toBe("qual-v1");
    expect(env.VERIFICATION_DNS_TIMEOUT_MS).toBe(3000);
    expect(env.OLLAMA_BASE_URL).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
  });

  it("parses and validates Phase 5 settings", () => {
    const env = loadEnv({
      ...base,
      QUALIFICATION_AI_PROVIDER: "Ollama",
      OLLAMA_BASE_URL: "http://localhost:11434",
      QUALIFICATION_PROMPT_VERSION: "qual-v2",
      VERIFICATION_DNS_TIMEOUT_MS: "1500",
    });
    expect(env.QUALIFICATION_AI_PROVIDER).toBe("ollama");
    expect(env.VERIFICATION_DNS_TIMEOUT_MS).toBe(1500);
    expect(env.QUALIFICATION_PROMPT_VERSION).toBe("qual-v2");
    expect(() => loadEnv({ ...base, QUALIFICATION_AI_PROVIDER: "openai" })).toThrow(
      /QUALIFICATION_AI_PROVIDER/,
    );
    expect(() => loadEnv({ ...base, VERIFICATION_DNS_TIMEOUT_MS: "50" })).toThrow(
      /VERIFICATION_DNS_TIMEOUT_MS/,
    );
    expect(() => loadEnv({ ...base, QUALIFICATION_PROMPT_VERSION: "v 1; drop" })).toThrow(
      /QUALIFICATION_PROMPT_VERSION/,
    );
  });

  it("requires the key / base URL of the chosen AI provider and refuses mock in production", () => {
    expect(() => loadEnv({ ...base, QUALIFICATION_AI_PROVIDER: "gemini" })).toThrow(
      /GEMINI_API_KEY/,
    );
    expect(() => loadEnv({ ...base, QUALIFICATION_AI_PROVIDER: "ollama" })).toThrow(
      /OLLAMA_BASE_URL/,
    );
    const g = loadEnv({ ...base, QUALIFICATION_AI_PROVIDER: "gemini", GEMINI_API_KEY: "k-test" });
    expect(g.QUALIFICATION_AI_PROVIDER).toBe("gemini");
    expect(JSON.stringify(integrationStatus(g))).not.toContain("k-test");
    expect(() =>
      loadEnv({
        ...base,
        APP_ENV: "production",
        AUTH_SECRET: "x".repeat(40),
        RESEARCH_USER_AGENT_CONTACT: "ops@example.org",
        QUALIFICATION_AI_PROVIDER: "mock",
      }),
    ).toThrow(/QUALIFICATION_AI_PROVIDER=mock is not allowed in production/);
  });
});
