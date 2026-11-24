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
});
