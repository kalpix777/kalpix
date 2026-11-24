// Integration: real PostgreSQL (DATABASE_URL, migrated), mock provider, no network.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createDiscoveryStack, MockDiscoveryProvider } from "@kalpix/providers";
import { claimNextRun, drainQueue, processRun } from "./process-run";

const db = new PrismaClient();
const tag = `it-${Date.now()}`;
const area = "15.80,74.40,15.82,74.42"; // explicit bbox: no geocoding
const stack = () => createDiscoveryStack("mock", { APP_ENV: "test" });

async function enqueue(categories: string[], extra: object = {}) {
  return db.discoveryRun.create({
    data: { area, categories, provider: "mock-discovery", startedByLabel: tag, ...extra },
  });
}
// Mock provider ids are not area-scoped (mock/<category>/<n>), so MOCK rows left by another suite
// (e2e, a manual mock run) would be "updated" instead of created. Start and end with none.
const MOCK_ROWS = { provider: "mock-discovery" } as const;
const bizCount = () => db.business.count({ where: MOCK_ROWS });

// The provider row is restored afterwards, so running this against a dev database is safe.
let original: { enabled: boolean; commercialUseVerified: boolean } | null = null;
beforeAll(async () => {
  original = await db.providerConfig.findUnique({
    where: { id: "osm-overpass" },
    select: { enabled: true, commercialUseVerified: true },
  });
  await db.business.deleteMany({ where: MOCK_ROWS });
  // These tests drain the queue, so they refuse to run while real runs are waiting.
  const busy = await db.discoveryRun.count({ where: { status: { in: ["queued", "running"] } } });
  if (busy)
    throw new Error(
      `${busy} discovery run(s) queued/running: run integration tests on an idle queue`,
    );
});
afterAll(async () => {
  if (original) await db.providerConfig.update({ where: { id: "osm-overpass" }, data: original });
  await db.business.deleteMany({ where: MOCK_ROWS });
  await db.discoveryRun.deleteMany({ where: { startedByLabel: tag } });
  await db.$disconnect();
});

describe("discovery job runner (real DB)", () => {
  it("processes a run: creates businesses, merges the fuzzy duplicate, records counts", async () => {
    const run = await enqueue(["restaurants", "garages"]);
    expect(await drainQueue(db, "it-worker", { stack: stack() })).toBe(1);
    const r = await db.discoveryRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(r.status).toBe("succeeded");
    expect(r).toMatchObject({
      foundCount: 8,
      createdCount: 6,
      duplicateCount: 2,
      updatedCount: 0,
      attempts: 1,
    });
    expect(r.completedCategories).toEqual(["restaurants", "garages"]);
    expect(r.bboxSouth).toBe(15.8);
    expect(await bizCount()).toBe(6);
    const merged = await db.business.findFirstOrThrow({
      where: { providerId: "mock/restaurants/1" },
    });
    expect(merged.alternateIds).toEqual(["mock-discovery:mock/restaurants/1-dup"]);
    expect(merged).toMatchObject({
      source: "mock",
      sourceType: "mock",
      hasWebsite: true,
      status: "NEW",
      firstRunId: run.id,
    });
  });

  it("is idempotent: re-running the same area creates nothing new", async () => {
    const run = await enqueue(["restaurants", "garages"]);
    await drainQueue(db, "it-worker", { stack: stack() });
    const r = await db.discoveryRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(r).toMatchObject({
      status: "succeeded",
      createdCount: 0,
      updatedCount: 6,
      duplicateCount: 2,
    });
    expect(await bizCount()).toBe(6);
    // processing an already-finished run again is a no-op
    expect(await processRun(db, run.id, { stack: stack() })).toBe("succeeded");
  });

  it("resumes after a crash without repeating completed categories", async () => {
    await db.business.deleteMany({ where: MOCK_ROWS });
    const run = await enqueue(["restaurants", "hotels", "retail"]);
    const id = await claimNextRun(db, "crashy");
    expect(id).toBe(run.id);
    await expect(
      processRun(db, run.id, { stack: stack(), crashAfterCategories: 1 }),
    ).rejects.toThrow(/Simulated crash/);
    let r = await db.discoveryRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(r.status).toBe("running");
    expect(r.completedCategories).toEqual(["restaurants"]);
    // fresh lock: another worker must not steal it
    expect(await claimNextRun(db, "other")).toBeNull();
    // stale lock: claimable again, resumes with the remaining categories
    expect(await claimNextRun(db, "other", 0)).toBe(run.id);
    const p = new MockDiscoveryProvider();
    const s = { ...stack(), discovery: p };
    await processRun(db, run.id, { stack: s });
    r = await db.discoveryRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(r.status).toBe("succeeded");
    expect(r.completedCategories).toEqual(["restaurants", "hotels", "retail"]);
    expect(r.attempts).toBe(2);
    expect(r.createdCount).toBe(9);
    expect(p.requestsMade).toBe(2); // restaurants was not queried again
    expect(await bizCount()).toBe(9);
  });

  it("marks a provider failure as failed with the error, keeping completed progress", async () => {
    const p = new MockDiscoveryProvider();
    p.failOnce.add("hotels");
    const run = await enqueue(["restaurants", "hotels"]);
    await drainQueue(db, "it-worker", { stack: { ...stack(), discovery: p } });
    const r = await db.discoveryRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(r.status).toBe("failed");
    expect(r.error).toBe("hotels: MOCK failure for hotels");
    expect(r.completedCategories).toEqual(["restaurants"]);
    // retry (what the admin "Retry" action does) resumes and succeeds
    await db.discoveryRun.update({
      where: { id: run.id },
      data: { status: "queued", error: null },
    });
    await drainQueue(db, "it-worker", { stack: { ...stack(), discovery: p } });
    expect((await db.discoveryRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
      "succeeded",
    );
  });

  it("refuses a disabled real provider and records no usage", async () => {
    await db.providerConfig.update({ where: { id: "osm-overpass" }, data: { enabled: false } });
    const run = await db.discoveryRun.create({
      data: { area, categories: ["retail"], provider: "osm-overpass", startedByLabel: tag },
    });
    const before = await db.usageEvent.count({ where: { entityId: run.id } });
    await drainQueue(db, "it-worker");
    const r = await db.discoveryRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/disabled/);
    expect(await db.usageEvent.count({ where: { entityId: run.id } })).toBe(before);
  });

  it("records UsageEvents for a real provider id (mocked HTTP)", async () => {
    await db.providerConfig.update({
      where: { id: "osm-overpass" },
      data: { enabled: true, commercialUseVerified: true },
    });
    try {
      const fetchImpl = async () =>
        new Response(
          JSON.stringify({
            elements: [
              {
                type: "node",
                id: 990001,
                lat: 15.81,
                lon: 74.41,
                tags: { shop: "clothes", name: "IT Fixture Textiles" },
              },
            ],
          }),
          { status: 200 },
        );
      const s = createDiscoveryStack("osm", { APP_ENV: "test" }, { fetchImpl });
      const run = await db.discoveryRun.create({
        data: { area, categories: ["retail"], provider: "osm-overpass", startedByLabel: tag },
      });
      await drainQueue(db, "it-worker", { stack: s });
      const r = await db.discoveryRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(r).toMatchObject({ status: "succeeded", createdCount: 1, requestCount: 1 });
      const u = await db.usageEvent.findMany({ where: { entityId: run.id } });
      expect(u).toHaveLength(1);
      expect(u[0]).toMatchObject({
        providerId: "osm-overpass",
        operation: "discovery.search",
        units: 1,
        costMinor: 0,
        isEstimate: false,
      });
      const b = await db.business.findFirstOrThrow({ where: { providerId: "node/990001" } });
      expect(b).toMatchObject({
        category: "retail",
        license: "ODbL-1.0",
        sourceUrl: "https://www.openstreetmap.org/node/990001",
        hasWebsite: false,
      });
      await db.business.delete({ where: { id: b.id } });
      await db.usageEvent.deleteMany({ where: { entityId: run.id } });
    } finally {
      await db.providerConfig.update({ where: { id: "osm-overpass" }, data: { enabled: false } });
    }
  });
});
