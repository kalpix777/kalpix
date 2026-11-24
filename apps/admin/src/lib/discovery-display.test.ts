import { describe, expect, it } from "vitest";
import {
  canRetryRun,
  envValueForKind,
  formatConfidence,
  isActiveRun,
  isMockSource,
  parsePage,
  providerLabel,
  safeHttpUrl,
} from "./discovery-display";

describe("discovery display helpers", () => {
  it("classifies run statuses", () => {
    expect(isActiveRun("queued")).toBe(true);
    expect(isActiveRun("running")).toBe(true);
    expect(isActiveRun("succeeded")).toBe(false);
    expect(canRetryRun("failed")).toBe(true);
    expect(canRetryRun("cancelled")).toBe(true);
    expect(canRetryRun("running")).toBe(false);
  });
  it("labels mock data visibly", () => {
    expect(providerLabel("mock-discovery")).toMatch(/MOCK/);
    expect(isMockSource({ source: "mock" })).toBe(true);
    expect(isMockSource({ provider: "mock-discovery" })).toBe(true);
    expect(isMockSource({ source: "openstreetmap", provider: "osm-overpass" })).toBe(false);
  });
  it("maps provider kinds to DISCOVERY_PROVIDER values", () => {
    expect(envValueForKind("osm")).toBe("overpass");
    expect(envValueForKind("google-places")).toBe("google_places");
    expect(envValueForKind("mock")).toBe("mock");
    expect(envValueForKind(null)).toBe("overpass");
  });
  it("only renders http(s) links", () => {
    expect(safeHttpUrl("example.in")).toBe("https://example.in/");
    expect(safeHttpUrl("http://a.test/x")).toBe("http://a.test/x");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("")).toBeNull();
  });
  it("formats confidence and parses pages safely", () => {
    expect(formatConfidence(0.734)).toBe("73%");
    expect(formatConfidence(2)).toBe("100%");
    expect(parsePage("3")).toBe(3);
    expect(parsePage("-1")).toBe(1);
    expect(parsePage("abc")).toBe(1);
    expect(parsePage(undefined)).toBe(1);
  });
});
