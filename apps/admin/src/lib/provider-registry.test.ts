import { describe, expect, it } from "vitest";
import { PROVIDER_REGISTRY, secretStatus } from "./provider-registry";

describe("provider registry", () => {
  it("has unique ids and valid fallbacks", () => {
    const ids = PROVIDER_REGISTRY.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PROVIDER_REGISTRY)
      if (p.fallbackProviderId) expect(ids).toContain(p.fallbackProviderId);
  });
  it("every paid provider requires at least one secret", () => {
    for (const p of PROVIDER_REGISTRY.filter((p) => p.costTier === "paid"))
      expect(p.requiredSecrets.length).toBeGreaterThan(0);
  });
  it("secretStatus never returns values", () => {
    const s = secretStatus(["A", "B"], { A: "secret-value", B: "" });
    expect(s).toEqual({ configured: ["A"], missing: ["B"], complete: false });
    expect(JSON.stringify(s)).not.toContain("secret-value");
  });
});
