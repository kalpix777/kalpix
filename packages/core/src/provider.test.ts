import { describe, expect, it } from "vitest";
import { canEnable, type ProviderDescriptor } from "./provider";

const places: ProviderDescriptor = {
  id: "google-places",
  name: "Google Places",
  category: "discovery",
  costTier: "paid",
  requiredSecrets: ["GOOGLE_PLACES_API_KEY"],
  commercialUseVerified: true,
};

describe("canEnable", () => {
  it("refuses a provider whose secrets are missing", () => {
    const r = canEnable(places, new Set());
    expect(r.ok).toBe(false);
  });
  it("refuses a provider whose commercial terms are unverified", () => {
    const r = canEnable(
      { ...places, commercialUseVerified: false },
      new Set(["GOOGLE_PLACES_API_KEY"]),
    );
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/Commercial-use/) });
  });
  it("allows a configured, verified provider", () => {
    expect(canEnable(places, new Set(["GOOGLE_PLACES_API_KEY"])).ok).toBe(true);
  });
});
