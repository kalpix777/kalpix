// Integration: real PostgreSQL (DATABASE_URL, migrated + seeded) and in-process HTTP servers on
// 127.0.0.1. The HTTP research provider is built with allowLoopbackForTests (an explicit test-only
// flag); without it, the SSRF guard refuses loopback. No external network is used.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createResearchProvider, MockResearchProvider } from "@kalpix/providers";
import {
  claimNextResearchRun,
  drainResearchQueue,
  enqueueResearchRun,
  processResearchRun,
} from "./research-run";

const db = new PrismaClient();
const tag = `it-research-${Date.now()}`;
const PROVIDER = "http-extractor";
const BIZ = { provider: "it-research" } as const;

// ---------- local sites ----------
type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
const servers: http.Server[] = [];
const hits: { site: string; path: string; ua: string }[] = [];
async function site(
  name: string,
  routes: Record<string, [number, string, Record<string, string>?]>,
) {
  const handler: Handler = (req, res) => {
    hits.push({ site: name, path: req.url ?? "", ua: String(req.headers["user-agent"]) });
    const r = routes[req.url ?? "/"];
    if (!r) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(r[0], { "content-type": "text/html; charset=utf-8", ...(r[2] ?? {}) }).end(r[1]);
  };
  const s = http.createServer(handler);
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}/`;
}

const HOME = `<!doctype html><html><head>
<meta name="viewport" content="width=device-width"><title>IT Sagar</title>
<meta name="description" content="Integration fixture">
<link rel="stylesheet" href="/wp-content/themes/x.css">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Restaurant",
 "name":"IT Sagar","telephone":"+91 831 246 1234","email":"hello@itsagar.in",
 "address":{"@type":"PostalAddress","streetAddress":"1 Test Road","addressLocality":"Belagavi","postalCode":"590006"},
 "sameAs":["https://www.facebook.com/itsagar"]}</script></head>
<body><a href="/contact">Contact us</a> <a href="/private/contact">Private contact</a>
<a href="https://wa.me/919845012345">WhatsApp</a> © 2024</body></html>`;
const CONTACT = `<html><body><p>Mobile: <a href="tel:+919845012345">98450 12345</a></p>
<p>sales [at] itsagar [dot] in</p></body></html>`;

let ok = "";
let broken = "";
let blocked = "";
let ssrf = "";
const ids: Record<string, string> = {};
let original: {
  enabled: boolean;
  commercialUseVerified: boolean;
  monthlyLimitUnits: number | null;
} | null = null;

const httpProvider = () =>
  createResearchProvider(
    "http",
    {
      APP_ENV: "test",
      RESEARCH_HOST_DELAY_MS: "0",
      RESEARCH_MAX_PAGES: "5",
      RESEARCH_USER_AGENT_CONTACT: "it@kalpix.test",
    },
    { allowLoopbackForTests: true },
  );

async function business(
  key: string,
  data: { website?: string | null; phone?: string | null; category?: string; firstRunId?: string },
) {
  const b = await db.business.create({
    data: {
      name: `IT Research ${key}`,
      normalizedName: `it research ${key}`,
      category: data.category ?? "restaurants",
      provider: BIZ.provider,
      providerId: `${tag}/${key}`,
      lat: 15.85,
      lon: 74.5,
      phone: data.phone ?? null,
      website: data.website ?? null,
      hasWebsite: Boolean(data.website),
      source: "openstreetmap",
      sourceType: "open_data",
      sourceUrl: `https://www.openstreetmap.org/node/${key.length}${Date.now() % 100000}`,
      collectedAt: new Date("2026-11-20T00:00:00Z"),
      lastSeenAt: new Date("2026-11-20T00:00:00Z"),
      confidence: 0.8,
      license: "ODbL-1.0",
      usageRestrictions: "ODbL: attribution required",
      firstRunId: data.firstRunId ?? null,
    },
  });
  ids[key] = b.id;
  return b;
}

beforeAll(async () => {
  const busy = await db.researchRun.count({ where: { status: { in: ["queued", "running"] } } });
  if (busy)
    throw new Error(
      `${busy} research run(s) queued/running: run integration tests on an idle queue`,
    );
  original = await db.providerConfig.findUnique({
    where: { id: PROVIDER },
    select: { enabled: true, commercialUseVerified: true, monthlyLimitUnits: true },
  });
  if (!original) throw new Error("http-extractor missing from provider_config: run pnpm db:seed");
  await db.providerConfig.update({
    where: { id: PROVIDER },
    data: { enabled: true, monthlyLimitUnits: null },
  });

  ok = await site("ok", {
    "/robots.txt": [200, "User-agent: *\nDisallow: /private\n", { "content-type": "text/plain" }],
    "/": [200, HOME, { "last-modified": "Wed, 21 Oct 2025 07:28:00 GMT" }],
    "/contact": [200, CONTACT],
    "/private/contact": [200, "<html>+91 99999 99999</html>"],
  });
  broken = await site("broken", { "/": [500, "oops"] });
  blocked = await site("blocked", {
    "/robots.txt": [200, "User-agent: *\nDisallow: /\n", { "content-type": "text/plain" }],
  });
  ssrf = await site("ssrf", { "/": [302, "", { location: "http://10.0.0.1/admin" }] });

  await business("agree", { website: ok, phone: "+91 831 246 1234" });
  await business("conflict", { website: ok, phone: "+91 99000 11111" });
  await business("broken", { website: broken });
  await business("blocked", { website: blocked });
  await business("none", { website: null, phone: "0831 2400000" });
  await business("ssrf", { website: ssrf });
});

afterAll(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  if (original) await db.providerConfig.update({ where: { id: PROVIDER }, data: original });
  const runs = await db.researchRun.findMany({
    where: { startedByLabel: tag },
    select: { id: true },
  });
  await db.usageEvent.deleteMany({
    where: { entityType: "research_run", entityId: { in: runs.map((r) => r.id) } },
  });
  await db.business.deleteMany({ where: BIZ }); // cascades facts and business_research
  await db.researchRun.deleteMany({ where: { startedByLabel: tag } });
  await db.discoveryRun.deleteMany({ where: { startedByLabel: tag } });
  await db.$disconnect();
});

const enqueue = (keys: string[], extra: Partial<Parameters<typeof enqueueResearchRun>[1]> = {}) =>
  enqueueResearchRun(db, {
    scopeType: "businesses",
    businessIds: keys.map((k) => ids[k]!),
    provider: PROVIDER,
    startedByLabel: tag,
    ...extra,
  });

describe("research job runner (real DB, local HTTP sites)", () => {
  let firstRunId = "";

  it("researches every business: ok, broken, blocked, no website, SSRF; facts with provenance", async () => {
    const { run } = await enqueue(["agree", "conflict", "broken", "blocked", "none", "ssrf"], {
      idempotencyKey: `${tag}-1`,
    });
    firstRunId = run.id;
    expect(await drainResearchQueue(db, "it-worker", { provider: httpProvider() })).toBe(1);
    const r = await db.researchRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(r).toMatchObject({
      status: "succeeded",
      totalCount: 6,
      processedCount: 6,
      okCount: 2,
      brokenCount: 2,
      blockedCount: 1,
      noWebsiteCount: 1,
      errorCount: 0,
      conflictCount: 1,
      attempts: 1,
    });
    expect(r.targetIds).toHaveLength(6);

    const results = await db.businessResearch.findMany({ where: { runId: run.id } });
    const st = Object.fromEntries(
      results.map((x) => [Object.keys(ids).find((k) => ids[k] === x.businessId), x]),
    );
    expect(st.agree).toMatchObject({ status: "ok", httpStatus: 200, conflictFields: [] });
    expect(st.conflict).toMatchObject({ status: "ok", conflictFields: ["phone"] });
    expect(st.broken).toMatchObject({ status: "broken", httpStatus: 500 });
    expect(st.blocked?.status).toBe("blocked");
    expect(st.none?.status).toBe("no_website");
    expect(st.ssrf?.status).toBe("broken");
    expect((st.ssrf?.signals as { broken?: string }).broken).toBe("ssrf_blocked");
    expect(st.agree?.signals).toMatchObject({
      https: false,
      hasViewport: true,
      hasTitle: true,
      hasMetaDescription: true,
      copyrightYear: 2024,
      lastModified: "2025-10-21T07:28:00.000Z",
      robotsTxt: "found",
      pagesFetched: 2,
      tech: ["WordPress"],
    });
    expect(st.agree?.summary).toMatch(/plain HTTP/);

    // robots.txt honoured, identifying UA, robots fetched once per site (cache)
    expect(hits.some((h) => h.path.startsWith("/private"))).toBe(false);
    expect(hits.filter((h) => h.site === "ok" && h.path === "/robots.txt")).toHaveLength(1);
    expect(
      hits.every((h) => h.ua.startsWith("KalpixBot/0.1") && h.ua.includes("it@kalpix.test")),
    ).toBe(true);
    expect(hits.filter((h) => h.site === "blocked").map((h) => h.path)).toEqual(["/robots.txt"]);

    // facts: website + listing, uniform provenance
    const facts = await db.researchFact.findMany({ where: { businessId: ids.agree } });
    const phone = facts.filter((f) => f.field === "phone");
    expect(
      phone.map((f) => `${f.sourceType}:${f.normalizedValue}:${f.verificationStatus}`).sort(),
    ).toEqual([
      "html:+919845012345:unverified",
      "jsonld:+918312461234:unverified",
      "osm:+918312461234:unverified",
    ]);
    const web = facts.find((f) => f.sourceType === "jsonld" && f.field === "email")!;
    expect(web).toMatchObject({
      normalizedValue: "hello@itsagar.in",
      sourceUrl: ok,
      provider: PROVIDER,
      confidence: 0.8,
      firstRunId: run.id,
      lastRunId: run.id,
    });
    expect(web.usageRestriction).toMatch(/robots\.txt/);
    expect(
      facts.find((f) => f.field === "email" && f.normalizedValue === "sales@itsagar.in")?.sourceUrl,
    ).toBe(`${ok}contact`);
    expect(facts.find((f) => f.field === "whatsapp")?.normalizedValue).toBe("+919845012345");
    expect(facts.find((f) => f.field === "social_facebook")?.normalizedValue).toBe(
      "https://facebook.com/itsagar",
    );
    const osmFact = facts.find((f) => f.sourceType === "osm" && f.field === "phone")!;
    expect(osmFact).toMatchObject({
      provider: "it-research",
      confidence: 0.8,
      usageRestriction: "ODbL: attribution required",
    });

    const conflict = await db.researchFact.findMany({
      where: { businessId: ids.conflict, field: "phone" },
    });
    expect(conflict.every((f) => f.verificationStatus === "conflicting")).toBe(true);
    expect(conflict.some((f) => f.sourceType === "osm")).toBe(true);
    // listing facts are kept for a business without a website too
    expect(
      await db.researchFact.count({
        where: { businessId: ids.none, sourceType: "osm", field: "phone" },
      }),
    ).toBe(1);

    const b = await db.business.findUniqueOrThrow({ where: { id: ids.agree } });
    expect(b.lastResearchedAt).not.toBeNull();

    // usage: one event per business with requests, cost 0, units = requests
    const usage = await db.usageEvent.findMany({
      where: { entityType: "research_run", entityId: run.id },
    });
    expect(
      usage.every(
        (u) => u.providerId === PROVIDER && u.costMinor === 0 && u.operation === "research.fetch",
      ),
    ).toBe(true);
    expect(usage.reduce((s, u) => s + u.units, 0)).toBe(r.requestCount);
    expect(r.requestCount).toBeGreaterThan(0);
    expect(r.factCount).toBeGreaterThan(0);
    expect(r.newFactCount).toBe(await db.researchFact.count({ where: { business: BIZ } }));
  });

  it("is idempotent: same key returns the run; re-research creates no duplicate facts", async () => {
    const again = await enqueue(["agree"], { idempotencyKey: `${tag}-1` });
    expect(again).toMatchObject({ created: false, run: { id: firstRunId } });
    const before = await db.researchFact.count({ where: { business: BIZ } });
    const { run } = await enqueue(["agree", "conflict", "none"]);
    await drainResearchQueue(db, "it-worker", { provider: httpProvider() });
    const r = await db.researchRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(r).toMatchObject({
      status: "succeeded",
      processedCount: 3,
      newFactCount: 0,
      conflictCount: 1,
    });
    expect(await db.researchFact.count({ where: { business: BIZ } })).toBe(before);
    const f = await db.researchFact.findFirstOrThrow({
      where: { businessId: ids.agree, sourceType: "jsonld", field: "phone" },
    });
    expect(f).toMatchObject({ firstRunId, lastRunId: run.id });
    expect(await processResearchRun(db, run.id, { provider: httpProvider() })).toBe("succeeded"); // no-op
  });

  it("resumes after a crash without re-researching finished businesses", async () => {
    const { run } = await enqueue(["agree", "broken", "none"], { provider: "mock-research" });
    expect(await claimNextResearchRun(db, "crashy")).toBe(run.id);
    const m1 = new MockResearchProvider();
    await expect(
      processResearchRun(db, run.id, { provider: m1, crashAfterBusinesses: 1 }),
    ).rejects.toThrow(/Simulated crash/);
    let r = await db.researchRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(r).toMatchObject({ status: "running", processedCount: 1 });
    expect(await claimNextResearchRun(db, "other")).toBeNull(); // fresh lock is respected
    expect(await claimNextResearchRun(db, "other", 0)).toBe(run.id); // stale lock reclaimed
    const m2 = new MockResearchProvider();
    await processResearchRun(db, run.id, { provider: m2 });
    r = await db.researchRun.findUniqueOrThrow({ where: { id: run.id } });
    // (the mock reports "broken" only for URLs containing "broken"; the local site URL is ok)
    expect(r).toMatchObject({
      status: "succeeded",
      processedCount: 3,
      attempts: 2,
      okCount: 2,
      noWebsiteCount: 1,
    });
    expect(m1.calls).toEqual([ids.agree]);
    expect(m2.calls).toEqual([ids.broken, ids.none]);
    expect(await db.businessResearch.count({ where: { runId: run.id } })).toBe(3);
    // MOCK facts are labelled and never billed
    expect(
      await db.researchFact.count({ where: { businessId: ids.agree, sourceType: "mock" } }),
    ).toBeGreaterThan(0);
    expect(await db.usageEvent.count({ where: { entityId: run.id } })).toBe(0);
  });

  it("records a per-business provider failure and continues the run", async () => {
    const m = new MockResearchProvider();
    m.failOnce.add(ids.broken!);
    const { run } = await enqueue(["broken", "none"], { provider: "mock-research" });
    await drainResearchQueue(db, "it-worker", { provider: m });
    const r = await db.researchRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(r).toMatchObject({
      status: "succeeded",
      errorCount: 1,
      noWebsiteCount: 1,
      processedCount: 2,
    });
    expect(r.errors).toEqual([
      { businessId: ids.broken, error: `MOCK research failure for ${ids.broken}` },
    ]);
    const row = await db.businessResearch.findFirstOrThrow({
      where: { runId: run.id, businessId: ids.broken },
    });
    expect(row).toMatchObject({ status: "error" });
  });

  it("stops at the monthly limit, keeping progress, and refuses a disabled provider", async () => {
    const month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const used = await db.usageEvent.aggregate({
      where: { providerId: PROVIDER, createdAt: { gte: month } },
      _sum: { units: true },
    });
    await db.providerConfig.update({
      where: { id: PROVIDER },
      data: { monthlyLimitUnits: used._sum.units ?? 0 },
    });
    try {
      const { run } = await enqueue(["agree"]);
      await drainResearchQueue(db, "it-worker", { provider: httpProvider() });
      const r = await db.researchRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(r.status).toBe("failed");
      expect(r.error).toMatch(/monthly limit/);
      expect(await db.usageEvent.count({ where: { entityId: run.id } })).toBe(0);
    } finally {
      await db.providerConfig.update({
        where: { id: PROVIDER },
        data: { monthlyLimitUnits: null },
      });
    }
    await db.providerConfig.update({ where: { id: PROVIDER }, data: { enabled: false } });
    try {
      const { run } = await enqueue(["agree"]);
      const before = hits.length;
      await drainResearchQueue(db, "it-worker", { provider: httpProvider() });
      const r = await db.researchRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(r).toMatchObject({ status: "failed", processedCount: 0 });
      expect(r.error).toMatch(/disabled/);
      expect(hits.length).toBe(before); // no request made
    } finally {
      await db.providerConfig.update({ where: { id: PROVIDER }, data: { enabled: true } });
    }
  });

  it("resolves discovery-run and filter scopes, and validates input", async () => {
    const dr = await db.discoveryRun.create({
      data: {
        area: "1,1,2,2",
        categories: ["retail"],
        provider: "mock-discovery",
        startedByLabel: tag,
        status: "succeeded",
      },
    });
    await business("fromdr", { website: null, category: "it_research_cat", firstRunId: dr.id });
    const a = await enqueueResearchRun(db, {
      scopeType: "discovery_run",
      discoveryRunId: dr.id,
      provider: "mock-research",
      startedByLabel: tag,
    });
    const b = await enqueueResearchRun(db, {
      scopeType: "filter",
      filter: { category: "it_research_cat", hasWebsite: false },
      provider: "mock-research",
      startedByLabel: tag,
    });
    await drainResearchQueue(db, "it-worker", { provider: new MockResearchProvider() });
    for (const id of [a.run.id, b.run.id]) {
      const r = await db.researchRun.findUniqueOrThrow({ where: { id } });
      expect(r).toMatchObject({ status: "succeeded", totalCount: 1, noWebsiteCount: 1 });
      expect(r.targetIds).toEqual([ids.fromdr]);
    }
    // researched just now (scope is resolved when the run starts), so a stale filter skips it
    const c = await enqueueResearchRun(db, {
      scopeType: "filter",
      filter: { category: "it_research_cat", staleAfterDays: 30 },
      provider: "mock-research",
      startedByLabel: tag,
    });
    await drainResearchQueue(db, "it-worker", { provider: new MockResearchProvider() });
    expect((await db.researchRun.findUniqueOrThrow({ where: { id: c.run.id } })).totalCount).toBe(
      0,
    );

    await expect(
      enqueueResearchRun(db, { scopeType: "filter", filter: { drop: 1 }, startedByLabel: tag }),
    ).rejects.toThrow(/Unknown/);
    await expect(
      enqueueResearchRun(db, { scopeType: "businesses", businessIds: [], startedByLabel: tag }),
    ).rejects.toThrow(/businessIds/);
    await expect(
      enqueueResearchRun(
        db,
        {
          scopeType: "businesses",
          businessIds: ["x"],
          provider: "mock-research",
          startedByLabel: tag,
        },
        { APP_ENV: "production" },
      ),
    ).rejects.toThrow(/production/);
  });
});
