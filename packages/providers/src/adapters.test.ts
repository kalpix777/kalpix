import { describe, expect, it, vi } from "vitest";
import { parseBBox } from "@kalpix/core";
import fixture from "./__fixtures__/overpass-belagavi.json";
import { backoffDelay, fetchWithRetry, type FetchLike } from "./http";
import { OverpassDiscoveryProvider } from "./osm/overpass";
import { NominatimGeocoder } from "./osm/nominatim";
import { GooglePlacesDiscoveryProvider } from "./google-places";
import { MockDiscoveryProvider } from "./mock";
import { createDiscoveryStack, resolveDiscoveryKind } from "./factory";
import { MemoryGeocodeCache } from "./cache";
import { RateLimiter } from "./rate-limiter";
import { csvCell, toCsv } from "./csv";

const noSleep = async () => {};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const area = {
  query: "test",
  displayName: "Test",
  bbox: { south: 15.85, west: 74.49, north: 15.87, east: 74.51 },
  source: "explicit-bbox",
};

describe("fetchWithRetry", () => {
  it("retries 429/5xx with backoff then succeeds", async () => {
    const f = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(new Response("bad gw", { status: 504 }))
      .mockResolvedValueOnce(json({ ok: 1 }));
    const sleeps: number[] = [];
    const r = await fetchWithRetry(
      "http://x",
      {},
      {
        timeoutMs: 1000,
        retries: 3,
        baseDelayMs: 100,
        maxDelayMs: 10_000,
        fetchImpl: f,
        sleep: async (ms) => void sleeps.push(ms),
      },
    );
    expect(r.attempts).toBe(3);
    expect(sleeps).toEqual([2000, 200]); // Retry-After honoured, then exponential
  });
  it("does not retry other 4xx and reports the status", async () => {
    const f = vi.fn<FetchLike>().mockResolvedValue(new Response("bad query", { status: 400 }));
    await expect(
      fetchWithRetry(
        "http://x",
        {},
        {
          timeoutMs: 1000,
          retries: 3,
          baseDelayMs: 1,
          maxDelayMs: 1,
          fetchImpl: f,
          sleep: noSleep,
        },
      ),
    ).rejects.toMatchObject({ status: 400, attempts: 1 });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("gives up after the retry budget on network errors", async () => {
    const f = vi.fn<FetchLike>().mockRejectedValue(new TypeError("fetch failed"));
    await expect(
      fetchWithRetry(
        "http://x",
        {},
        {
          timeoutMs: 1000,
          retries: 2,
          baseDelayMs: 1,
          maxDelayMs: 1,
          fetchImpl: f,
          sleep: noSleep,
        },
      ),
    ).rejects.toThrow(/Network error: fetch failed \(after 3 attempts\)/);
  });
  it("times out a hanging request", async () => {
    const f: FetchLike = (_u, init) =>
      new Promise((_r, rej) =>
        init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))),
      );
    await expect(
      fetchWithRetry(
        "http://x",
        {},
        { timeoutMs: 20, retries: 0, baseDelayMs: 1, maxDelayMs: 1, fetchImpl: f, sleep: noSleep },
      ),
    ).rejects.toThrow(/Timed out after 20 ms/);
  });
  it("caps backoff", () => {
    expect(backoffDelay(10, 1000, 5000)).toBe(5000);
    expect(backoffDelay(0, 1000, 60_000, "120")).toBe(60_000);
  });
});

describe("OverpassDiscoveryProvider (mocked HTTP)", () => {
  it("POSTs a bbox query with a User-Agent and normalises + de-duplicates the response", async () => {
    const f = vi.fn<FetchLike>().mockResolvedValue(json(fixture));
    const p = new OverpassDiscoveryProvider({
      endpoint: "https://overpass.test/api/interpreter",
      userAgent: "Kalpix-test/0.1",
      fetchImpl: f,
      sleep: noSleep,
      now: () => new Date("2026-11-22T00:00:00Z"),
    });
    const r = await p.search(area, ["restaurants", "hospitals", "garages", "education"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.candidates.map((c) => c.providerId)).toEqual([
      "node/1001",
      "way/2002",
      "node/1004",
    ]);
    expect(r.value.skipped).toBe(3); // unnamed, duplicate id, no centre
    expect(r.value.requests).toBe(1);
    expect(r.value.attribution).toMatch(/OpenStreetMap contributors/);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://overpass.test/api/interpreter");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["user-agent"]).toBe("Kalpix-test/0.1");
    const body = new URLSearchParams(String(init?.body)).get("data")!;
    expect(body).toContain("(15.85,74.49,15.87,74.51)");
    expect(p.requestsMade).toBe(1);
  });
  it("refuses areas larger than the fair-use limit without calling the API", async () => {
    const f = vi.fn<FetchLike>();
    const p = new OverpassDiscoveryProvider({ userAgent: "t", fetchImpl: f, maxBboxDeg2: 0.01 });
    const r = await p.search({ ...area, bbox: { south: 15, west: 74, north: 16, east: 75 } }, [
      "retail",
    ]);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/Area too large/) });
    expect(f).not.toHaveBeenCalled();
  });
  it("reports Overpass runtime errors and HTTP failures honestly", async () => {
    const remark = vi
      .fn<FetchLike>()
      .mockResolvedValue(
        json({ elements: [], remark: 'runtime error: Query timed out in "query"' }),
      );
    const p1 = new OverpassDiscoveryProvider({ userAgent: "t", fetchImpl: remark, sleep: noSleep });
    expect(await p1.search(area, ["retail"])).toEqual({
      ok: false,
      error: expect.stringMatching(/runtime error/),
    });
    const down = vi.fn<FetchLike>().mockResolvedValue(new Response("x", { status: 503 }));
    const p2 = new OverpassDiscoveryProvider({
      userAgent: "t",
      fetchImpl: down,
      sleep: noSleep,
      retries: 2,
    });
    const r = await p2.search(area, ["retail"]);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/HTTP 503.*after 3 attempts/) });
    expect(p2.requestsMade).toBe(3);
  });
  it("serialises concurrent queries through its rate limiter", async () => {
    let t = 0;
    const starts: number[] = [];
    const f = vi.fn<FetchLike>().mockImplementation(async () => {
      starts.push(t);
      return json({ elements: [] });
    });
    const limiter = new RateLimiter(
      2000,
      () => t,
      async (ms) => void (t += ms),
    );
    const p = new OverpassDiscoveryProvider({ userAgent: "t", fetchImpl: f, limiter });
    await Promise.all([p.search(area, ["retail"]), p.search(area, ["hotels"])]);
    expect(starts).toEqual([0, 2000]);
  });
});

describe("NominatimGeocoder (mocked HTTP)", () => {
  const hit = [
    {
      display_name: "Belagavi, Karnataka, India",
      boundingbox: ["15.78", "15.93", "74.43", "74.58"],
      osm_type: "relation",
      osm_id: 123,
    },
  ];
  it("requires a contact email before any request", async () => {
    const f = vi.fn<FetchLike>();
    const g = new NominatimGeocoder({ fetchImpl: f });
    const r = await g.geocode("Belagavi, Karnataka");
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/NOMINATIM_CONTACT_EMAIL/) });
    expect(f).not.toHaveBeenCalled();
  });
  it("identifies itself, parses the bbox, and caches the result", async () => {
    const f = vi.fn<FetchLike>().mockResolvedValue(json(hit));
    const g = new NominatimGeocoder({
      fetchImpl: f,
      contactEmail: "ops@kalpix.test",
      sleep: noSleep,
      cache: new MemoryGeocodeCache(),
    });
    const r = await g.geocode("Belagavi, Karnataka");
    expect(r.ok && r.value.area.bbox).toEqual({
      south: 15.78,
      north: 15.93,
      west: 74.43,
      east: 74.58,
    });
    expect(r.ok && r.value.area.sourceUrl).toBe("https://www.openstreetmap.org/relation/123");
    const [url, init] = f.mock.calls[0]!;
    expect(url).toContain(
      "/search?q=Belagavi%2C+Karnataka&format=jsonv2&limit=1&email=ops%40kalpix.test",
    );
    expect((init?.headers as Record<string, string>)["user-agent"]).toMatch(
      /^Kalpix\/.* \(ops@kalpix\.test\)$/,
    );
    const again = await g.geocode("  belagavi karnataka ");
    expect(again.ok && again.value.cached).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("waits at least 1 s between uncached requests", async () => {
    let t = 0;
    const starts: number[] = [];
    const f = vi.fn<FetchLike>().mockImplementation(async () => {
      starts.push(t);
      return json(hit);
    });
    const g = new NominatimGeocoder({
      fetchImpl: f,
      contactEmail: "ops@kalpix.test",
      limiter: new RateLimiter(
        1100,
        () => t,
        async (ms) => void (t += ms),
      ),
    });
    await Promise.all([g.geocode("Belagavi"), g.geocode("Hubballi"), g.geocode("Dharwad")]);
    expect(starts).toEqual([0, 1100, 2200]);
  });
  it("reports no match", async () => {
    const g = new NominatimGeocoder({
      fetchImpl: async () => json([]),
      contactEmail: "a@b.co",
      sleep: noSleep,
    });
    expect(await g.geocode("Nowhereville")).toEqual({
      ok: false,
      error: 'No place found for "Nowhereville"',
    });
  });
});

describe("Google Places stub", () => {
  it("cannot be enabled without a key", () => {
    expect(new GooglePlacesDiscoveryProvider({}).canEnable().ok).toBe(false);
  });
  it("cannot be enabled with a key until the owner confirms commercial terms", () => {
    const r = new GooglePlacesDiscoveryProvider({ GOOGLE_PLACES_API_KEY: "k" }).canEnable();
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/Commercial-use/) });
  });
  it("never returns data, even when enable rules pass", async () => {
    const g = new GooglePlacesDiscoveryProvider({ GOOGLE_PLACES_API_KEY: "k" }, true);
    expect(g.canEnable().ok).toBe(true);
    expect(await g.search()).toEqual({ ok: false, error: expect.stringMatching(/not built yet/) });
    expect(g.descriptor.costTier).toBe("paid");
  });
});

describe("factory, mock provider, bbox parsing and CSV", () => {
  it("defaults to OSM and refuses mock in production", () => {
    expect(resolveDiscoveryKind({})).toBe("osm");
    expect(resolveDiscoveryKind({ DISCOVERY_PROVIDER: "mock" })).toBe("mock");
    expect(() =>
      resolveDiscoveryKind({ DISCOVERY_PROVIDER: "mock", APP_ENV: "production" }),
    ).toThrow();
    expect(() => resolveDiscoveryKind({ DISCOVERY_PROVIDER: "bing" })).toThrow();
    expect(resolveDiscoveryKind({ DISCOVERY_PROVIDER: "overpass" })).toBe("osm");
    expect(resolveDiscoveryKind({ DISCOVERY_PROVIDER: "google_places" })).toBe("google-places");
    expect(resolveDiscoveryKind({ DISCOVERY_PROVIDER: "osm" })).toBe("osm"); // legacy alias
    expect(createDiscoveryStack("osm", {}).providerId).toBe("osm-overpass");
  });
  it("mock data is labelled MOCK and includes a near-duplicate", async () => {
    const r = await new MockDiscoveryProvider().search(area, ["restaurants"]);
    expect(
      r.ok && r.value.candidates.every((c) => /^mock/i.test(c.name) && c.source === "mock"),
    ).toBe(true);
    expect(r.ok && r.value.candidates).toHaveLength(4);
  });
  it("parses explicit bounding boxes", () => {
    expect(parseBBox("15.85, 74.49, 15.87, 74.51")).toEqual(area.bbox);
    expect(parseBBox("Belagavi, Karnataka")).toBeNull();
    expect(parseBBox("15.87,74.49,15.85,74.51")).toBeNull();
  });
  it("escapes CSV and neutralises spreadsheet formulas", () => {
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell("+918312422222")).toBe("'+918312422222");
    expect(csvCell(null)).toBe("");
    expect(toCsv(["a", "b"], [[1, "x\ny"]])).toBe('a,b\r\n1,"x\ny"\r\n');
  });
});
