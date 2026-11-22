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
});
