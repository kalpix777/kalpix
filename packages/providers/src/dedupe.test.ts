import { describe, expect, it } from "vitest";
import { boxAround, findDuplicate, haversineMeters, nameSimilarity, normalizeName } from "./dedupe";

const base = {
  provider: "osm-overpass",
  providerId: "node/1",
  name: "Hotel Sanman",
  category: "restaurants",
  lat: 15.86,
  lon: 74.51,
};

describe("dedupe", () => {
  it("normalises names", () => {
    expect(normalizeName("The Café Sagar & Sons Pvt. Ltd.")).toBe("cafe sagar sons");
    expect(normalizeName("  KLE's  Hospital ")).toBe("kles hospital");
  });
  it("scores similar names highly and different names low", () => {
    expect(nameSimilarity("Hotel Sanman", "Sanman Hotel")).toBe(1);
    expect(nameSimilarity("Cafe Sagar", "Café Sagar.")).toBe(1);
    expect(nameSimilarity("Hotel Sanman", "Hotel Sanmaan")).toBeGreaterThan(0.85);
    expect(nameSimilarity("Hotel Sanman", "Shree Medicals")).toBeLessThan(0.4);
  });
  it("computes distances", () => {
    expect(haversineMeters(15.86, 74.51, 15.86, 74.51)).toBe(0);
    const d = haversineMeters(15.86, 74.51, 15.8604, 74.51);
    expect(d).toBeGreaterThan(43);
    expect(d).toBeLessThan(46);
    const b = boxAround(15.86, 74.51, 50);
    expect(haversineMeters(15.86, 74.51, b.maxLat, 74.51)).toBeCloseTo(50, 0);
  });
  it("matches the same provider id regardless of name or place", () => {
    const m = findDuplicate({ ...base, name: "Renamed", lat: 16 }, [base]);
    expect(m?.reason).toBe("provider_id");
  });
  it("matches fuzzy duplicates under 50 m in the same category", () => {
    const other = { ...base, provider: "google-places", providerId: "g1", lat: 15.8603 }; // ~33 m
    expect(findDuplicate({ ...other, name: "Sanman Hotel" }, [base])?.reason).toBe("fuzzy");
  });
  it("does not match across categories, beyond 50 m, different names, or different numbers", () => {
    const c = { ...base, providerId: "node/2" };
    expect(findDuplicate({ ...c, category: "hotels" }, [base])).toBeNull();
    expect(findDuplicate({ ...c, lat: 15.8605 }, [base])).toBeNull(); // ~56 m
    expect(findDuplicate({ ...c, name: "Shree Medicals" }, [base])).toBeNull();
    const one = { ...base, name: "City Clinic 1" };
    expect(findDuplicate({ ...c, name: "City Clinic 2" }, [one])).toBeNull();
  });
  it("prefers the most similar candidate", () => {
    const a = { ...base, providerId: "node/a", name: "Hotel Sanmaan" };
    const b = { ...base, providerId: "node/b", name: "Hotel Sanman" };
    const m = findDuplicate({ ...base, providerId: "node/c" }, [a, b]);
    expect(m?.match.providerId).toBe("node/b");
  });
});
