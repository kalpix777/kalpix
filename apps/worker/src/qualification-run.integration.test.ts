// Integration: real PostgreSQL (DATABASE_URL, migrated + seeded). MOCK discovery -> MOCK research ->
// verification + qualification, with AI off, MOCK AI and Gemini over a fake fetch. DNS is a static
// fake resolver; no network is used.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  createDiscoveryStack,
  GeminiModelProvider,
  MockModelProvider,
  MockResearchProvider,
  StaticMxResolver,
  type ModelFetch,
} from "@kalpix/providers";
import { drainQueue } from "./process-run";
import { drainResearchQueue, enqueueResearchRun } from "./research-run";
import {
  claimNextQualificationRun,
  drainQualificationQueue,
  enqueueQualificationRun,
  processQualificationRun,
} from "./qualification-run";
import { clearFactOverride, overrideFactVerification } from "./verification-store";

const db = new PrismaClient();
const tag = `it-qual-${Date.now()}`;
const MOCK_ROWS = { provider: "mock-discovery" } as const;
const OWN = { provider: "it-qual" } as const;
const BIZ = { OR: [MOCK_ROWS, OWN] };
const mx = () =>
  new StaticMxResolver({
    "itsagar.in": { status: "ok", exchanges: ["mx1.itsagar.in"] },
    "gmail.com": { status: "ok", exchanges: ["gmail-smtp-in.l.google.com"] },
  });
const env = { APP_ENV: "test", QUALIFICATION_PROMPT_VERSION: "qual-v1" };
const ids: Record<string, string> = {};
let discoveryRunId = "";
let researchRunId = "";
let mockModelRowExisted = false;
let gemini: {
  enabled: boolean;
  commercialUseVerified: boolean;
  monthlyLimitUnits: number | null;
} | null = null;

const enqueue = (extra: Partial<Parameters<typeof enqueueQualificationRun>[1]>) =>
  enqueueQualificationRun(
    db,
    { scopeType: "businesses", startedByLabel: tag, ai: "none", ...extra },
    env,
  );

async function ownBusiness(
  key: string,
  data: { name?: string; lat?: number; rawTags?: object; state?: string; website?: string },
) {
  const b = await db.business.create({
    data: {
      name: data.name ?? `IT Qual ${key}`,
      normalizedName: (data.name ?? `it qual ${key}`).toLowerCase(),
      category: "restaurants",
      provider: OWN.provider,
      providerId: `${tag}/${key}`,
      lat: data.lat ?? 15.85,
      lon: 74.5,
      state: data.state ?? "Karnataka",
      website: data.website ?? null,
      hasWebsite: Boolean(data.website),
      source: "openstreetmap",
      sourceType: "open_data",
      sourceUrl: `https://www.openstreetmap.org/node/${key.length}${Date.now() % 100000}`,
      collectedAt: new Date("2026-11-20T00:00:00Z"),
      lastSeenAt: new Date("2026-11-20T00:00:00Z"),
      confidence: 0.8,
      rawTags: data.rawTags ?? { amenity: "restaurant" },
    },
  });
  ids[key] = b.id;
  return b;
}

async function addFact(
  businessId: string,
  field: string,
  value: string,
  sourceType: "osm" | "jsonld" | "html",
  sourceUrl: string,
) {
  return db.researchFact.create({
    data: {
      businessId,
      field,
      value,
      normalizedValue: value.toLowerCase(),
      sourceUrl,
      sourceType,
      provider: sourceType === "osm" ? "osm-overpass" : "http-extractor",
      collectedAt: new Date("2026-11-20T00:00:00Z"),
      confidence: 0.8,
    },
  });
}

beforeAll(async () => {
  const busy = await db.qualificationRun.count({
    where: { status: { in: ["queued", "running"] } },
  });
  const busyR = await db.researchRun.count({ where: { status: { in: ["queued", "running"] } } });
  const busyD = await db.discoveryRun.count({ where: { status: { in: ["queued", "running"] } } });
  if (busy || busyR || busyD)
    throw new Error("Queued/running runs exist: run integration tests on an idle queue");
  gemini = await db.providerConfig.findUnique({
    where: { id: "gemini" },
    select: { enabled: true, commercialUseVerified: true, monthlyLimitUnits: true },
  });
  if (!gemini) throw new Error("gemini missing from provider_config: run pnpm db:seed");
  mockModelRowExisted = Boolean(
    await db.providerConfig.findUnique({ where: { id: "mock-model" } }),
  );
  await db.business.deleteMany({ where: MOCK_ROWS });

  // own businesses with hand-made provenance facts
  const site = "https://itsagar.in/";
  const agree = await ownBusiness("agree", { name: "Hotel Itsagar", website: site });
  await addFact(agree.id, "phone", "+918312461234", "osm", agree.sourceUrl);
  await addFact(agree.id, "phone", "+918312461234", "jsonld", site);
  await addFact(agree.id, "email", "hello@itsagar.in", "jsonld", site);
  await addFact(agree.id, "website", site, "osm", agree.sourceUrl);
  await addFact(agree.id, "postcode", "590006", "osm", agree.sourceUrl);
  await addFact(agree.id, "address", "1 Test Road, Belagavi 590006", "jsonld", site);
  const rr = await db.researchRun.create({
    data: {
      provider: "mock-research",
      scopeType: "businesses",
      status: "succeeded",
      startedByLabel: tag,
    },
  });
  await db.businessResearch.create({
    data: {
      runId: rr.id,
      businessId: agree.id,
      provider: "http-extractor",
      status: "ok",
      httpStatus: 200,
      requestedUrl: site,
      finalUrl: site,
      signals: {
        noWebsite: false,
        requestedUrl: site,
        finalUrl: site,
        httpStatus: 200,
        https: false,
        hasViewport: false,
        hasTitle: true,
        hasMetaDescription: true,
      },
    },
  });
  const closed = await ownBusiness("closed", {
    rawTags: { "disused:amenity": "restaurant" },
    lat: 15.9,
  });
  await addFact(closed.id, "phone", "+919845012345", "osm", closed.sourceUrl);
  const dup = await ownBusiness("dup", { name: "Hotel Itsagar", lat: 15.85005 });
  await addFact(dup.id, "phone", "+919845099999", "osm", dup.sourceUrl);
  const none = await ownBusiness("nocontact", { lat: 15.95 });
  await addFact(none.id, "phone", "+910000000000", "osm", none.sourceUrl);
  await addFact(none.id, "email", "x@mailinator.com", "osm", none.sourceUrl);
});

afterAll(async () => {
  if (gemini) await db.providerConfig.update({ where: { id: "gemini" }, data: gemini });
  const runs = await db.qualificationRun.findMany({
    where: { startedByLabel: tag },
    select: { id: true },
  });
  await db.usageEvent.deleteMany({
    where: { entityType: "qualification_run", entityId: { in: runs.map((r) => r.id) } },
  });
  await db.business.deleteMany({ where: BIZ });
  await db.qualificationRun.deleteMany({ where: { startedByLabel: tag } });
  await db.researchRun.deleteMany({ where: { startedByLabel: tag } });
  await db.discoveryRun.deleteMany({ where: { startedByLabel: tag } });
  if (!mockModelRowExisted && !(await db.usageEvent.count({ where: { providerId: "mock-model" } })))
    await db.providerConfig.deleteMany({ where: { id: "mock-model" } });
  await db.$disconnect();
});

describe("qualification job runner (real DB)", () => {
  it("MOCK discovery -> MOCK research -> qualification with AI off", async () => {
    const d = await db.discoveryRun.create({
      data: {
        area: "15.80,74.40,15.82,74.42",
        categories: ["restaurants", "garages"],
        provider: "mock-discovery",
        startedByLabel: tag,
      },
    });
    discoveryRunId = d.id;
    await drainQueue(db, "it-worker", { stack: createDiscoveryStack("mock", { APP_ENV: "test" }) });
    const { run: rr } = await enqueueResearchRun(db, {
      scopeType: "discovery_run",
      discoveryRunId,
      provider: "mock-research",
      startedByLabel: tag,
    });
    researchRunId = rr.id;
    await drainResearchQueue(db, "it-worker", { provider: new MockResearchProvider() });
    expect((await db.researchRun.findUniqueOrThrow({ where: { id: rr.id } })).status).toBe(
      "succeeded",
    );

    const { run } = await enqueue({ scopeType: "research_run", researchRunId });
    expect(run).toMatchObject({ aiEnabled: false, aiProvider: null, rulesVersion: "rules-v1" });
    expect(await drainQualificationQueue(db, "it-worker", { mx: mx(), env })).toBe(1);
    const r = await db.qualificationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(r).toMatchObject({
      status: "succeeded",
      totalCount: 6,
      processedCount: 6,
      coldCount: 2,
      disqualifiedCount: 4,
      aiOkCount: 0,
      aiInputTokens: 0,
      attempts: 1,
    });
    expect(r.factsInvalidCount).toBeGreaterThan(0);
    const rows = await db.businessQualification.findMany({
      where: { runId: run.id },
      include: { business: true },
    });
    expect(rows).toHaveLength(6);
    expect(rows.every((x) => x.isMock && x.aiStatus === "off" && x.aiSummary === null)).toBe(true);
    const withSite = rows.find((x) => x.business.providerId === "mock/restaurants/1")!;
    expect(withSite).toMatchObject({ tier: "cold", disqualifiedReason: null });
    const reasons = withSite.reasons as { code: string; factIds: string[] }[];
    expect(reasons.map((x) => x.code)).toEqual(
      expect.arrayContaining(["phone", "missing_basics", "mock_data", "invalid_contacts"]),
    );
    expect(reasons.find((x) => x.code === "phone")!.factIds.length).toBe(1);
    for (const x of rows.filter((x) => x.tier === "disqualified"))
      expect(x.disqualifiedReason).toBe("no_contact_channel");
    // business listing columns
    expect(withSite.business).toMatchObject({ latestTier: "cold", latestScore: withSite.score });
    expect(withSite.business.qualifiedAt).not.toBeNull();
    // verification written with method + evidence: listing placeholder phone and MOCK email invalid
    const facts = await db.researchFact.findMany({ where: { businessId: withSite.businessId } });
    const bad = facts.find((f) => f.field === "phone" && f.normalizedValue === "+910000000000")!;
    expect(bad).toMatchObject({
      verificationStatus: "invalid",
      verificationMethod: "phone_format_agreement",
    });
    expect(bad.verifiedAt).not.toBeNull();
    expect(facts.find((f) => f.field === "email")).toMatchObject({ verificationStatus: "invalid" });
    const web = facts.find((f) => f.field === "website")!;
    expect(web).toMatchObject({
      verificationStatus: "verified",
      verificationMethod: "website_reachability",
    });
    expect(web.verificationEvidence).toMatchObject({ mock: true });
    expect(facts.find((f) => f.field === "postcode")).toMatchObject({
      verificationStatus: "invalid",
    });
    expect(await db.usageEvent.count({ where: { entityId: run.id } })).toBe(0);
  });

  it("MOCK AI adds labelled suggestions without changing any score, and records tokens", async () => {
    const { run } = await enqueue({ scopeType: "discovery_run", discoveryRunId, ai: "mock" });
    expect(run).toMatchObject({
      aiEnabled: true,
      aiProvider: "mock-model",
      promptVersion: "qual-v1",
    });
    const model = new MockModelProvider();
    await drainQualificationQueue(db, "it-worker", { mx: mx(), env, model });
    const r = await db.qualificationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(r).toMatchObject({
      status: "succeeded",
      processedCount: 6,
      aiOkCount: 2,
      aiErrorCount: 0,
      aiCostMinor: 0,
    });
    expect(r.aiInputTokens).toBeGreaterThan(0);
    expect(model.calls).toHaveLength(2); // disqualified businesses are not sent to AI
    for (const c of model.calls) expect(c).not.toMatch(/\+91\d{10}|mock\.invalid/); // contacts masked
    const rows = await db.businessQualification.findMany({ where: { runId: run.id } });
    const ai = rows.filter((x) => x.aiStatus === "ok");
    expect(ai).toHaveLength(2);
    for (const x of ai) {
      expect(x.aiSummary).toMatch(/^MOCK/);
      expect(x.aiPitch).toMatch(/^MOCK/);
      expect(x).toMatchObject({
        aiIsMock: true,
        aiProvider: "mock-model",
        aiModel: "mock-model-1",
        aiPromptVersion: "qual-v1",
        aiCostMinor: 0,
      });
      expect(x.aiInputTokens).toBeGreaterThan(0);
    }
    expect(rows.filter((x) => x.aiStatus === "skipped")).toHaveLength(4);
    // same scores and tiers as the rules-only run
    const prev = await db.businessQualification.findMany({
      where: { run: { scopeType: "research_run", researchRunId, startedByLabel: tag } },
    });
    const byBiz = new Map(prev.map((p) => [p.businessId, `${p.score}:${p.tier}`]));
    for (const x of rows) expect(`${x.score}:${x.tier}`).toBe(byBiz.get(x.businessId));
    const usage = await db.usageEvent.findMany({
      where: { entityType: "qualification_run", entityId: run.id },
    });
    expect(usage).toHaveLength(2);
    expect(
      usage.every(
        (u) =>
          u.providerId === "mock-model" && u.costMinor === 0 && u.operation === "qualification.ai",
      ),
    ).toBe(true);
    expect(usage.reduce((s, u) => s + u.units, 0)).toBe(r.aiInputTokens + r.aiOutputTokens);
  });

  it("malformed AI output is an AI error; the rules result is still stored", async () => {
    const model = new MockModelProvider();
    model.queuedRaw.push("Sure! This looks like a great lead.");
    const mockSite = await db.business.findFirstOrThrow({
      where: { providerId: "mock/restaurants/1" },
    });
    const { run } = await enqueue({ businessIds: [mockSite.id], ai: "mock" });
    await drainQualificationQueue(db, "it-worker", { mx: mx(), env, model });
    const r = await db.qualificationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(r).toMatchObject({ status: "succeeded", aiErrorCount: 1, aiOkCount: 0, coldCount: 1 });
    expect(JSON.stringify(r.errors)).toMatch(/malformed_output/);
    const row = await db.businessQualification.findFirstOrThrow({ where: { runId: run.id } });
    expect(row).toMatchObject({ aiStatus: "error", aiSummary: null, tier: "cold" });
    expect(row.aiError).toMatch(/malformed_output/);
    expect(row.aiOutputTokens).toBeGreaterThan(0);
  });

  it("verifies real-shaped facts; disqualifies closed, duplicate and no-contact businesses", async () => {
    const { run } = await enqueue({
      businessIds: ["agree", "closed", "dup", "nocontact"].map((k) => ids[k]!),
    });
    await drainQualificationQueue(db, "it-worker", { mx: mx(), env });
    const rows = await db.businessQualification.findMany({ where: { runId: run.id } });
    const by = Object.fromEntries(
      rows.map((x) => [Object.keys(ids).find((k) => ids[k] === x.businessId), x]),
    );
    expect(by.agree).toMatchObject({
      tier: "warm",
      score: 69,
      disqualifiedReason: null,
      isMock: false,
      operatingStatus: "no_evidence",
    });
    expect(by.agree!.components).toEqual({ website: 24, contact: 30, category: 15 });
    expect(by.closed).toMatchObject({
      tier: "disqualified",
      disqualifiedReason: "closed",
      operatingStatus: "closed",
    });
    expect(by.dup).toMatchObject({
      tier: "disqualified",
      disqualifiedReason: "duplicate",
      duplicateOfId: ids.agree,
    });
    expect(by.nocontact).toMatchObject({
      tier: "disqualified",
      disqualifiedReason: "no_contact_channel",
    });

    const facts = await db.researchFact.findMany({ where: { businessId: ids.agree } });
    const st = (field: string, type?: string) =>
      facts.find((f) => f.field === field && (!type || f.sourceType === type))!;
    expect(st("phone", "osm")).toMatchObject({
      verificationStatus: "verified",
      verificationMethod: "phone_format_agreement",
    });
    expect(st("phone", "jsonld").verificationStatus).toBe("verified");
    expect(st("email")).toMatchObject({
      verificationStatus: "verified",
      verificationMethod: "email_syntax_mx",
    });
    expect(st("email").verificationEvidence).toMatchObject({
      mx: "ok",
      domainMatchesWebsite: true,
    });
    expect(st("website")).toMatchObject({ verificationStatus: "verified" });
    expect(st("website").verificationEvidence).toMatchObject({ https: false, httpStatus: 200 });
    expect(st("postcode")).toMatchObject({
      verificationStatus: "verified",
      verificationMethod: "postcode_format_state",
    });
    const nf = await db.researchFact.findMany({ where: { businessId: ids.nocontact } });
    expect(nf.every((f) => f.verificationStatus === "invalid")).toBe(true);
    const reasons = by.agree!.reasons as { code: string; factIds: string[]; researchId?: string }[];
    expect(reasons.find((x) => x.code === "verified_phone")!.factIds).toHaveLength(2);
    expect(reasons.find((x) => x.code === "no_https")).toMatchObject({
      factIds: [st("website").id],
    });
    expect(reasons.find((x) => x.code === "no_https")!.researchId).toBeTruthy();
    const b = await db.business.findUniqueOrThrow({ where: { id: ids.agree } });
    expect(b).toMatchObject({ latestScore: 69, latestTier: "warm" });
  });

  it("manual override is kept by later passes, audited, and can be cleared", async () => {
    const osm = await db.researchFact.findFirstOrThrow({
      where: { businessId: ids.agree, field: "phone", sourceType: "osm" },
    });
    await expect(
      overrideFactVerification(db, {
        factId: osm.id,
        status: "invalid",
        reason: " ",
        actorLabel: tag,
      }),
    ).rejects.toThrow(/reason/);
    const o = await overrideFactVerification(db, {
      factId: osm.id,
      status: "invalid",
      reason: "Owner called: number disconnected",
      actorLabel: tag,
    });
    expect(o).toMatchObject({
      verificationOverride: true,
      verificationMethod: "manual",
      verifiedByLabel: tag,
      overrideReason: "Owner called: number disconnected",
    });
    expect(o.verificationEvidence).toMatchObject({
      previous: { status: "verified", method: "phone_format_agreement" },
    });
    const audit = await db.auditLog.findFirst({
      where: { action: "verification.override", entityId: osm.id },
    });
    expect(audit?.metadata).toMatchObject({ from: "verified", to: "invalid", field: "phone" });

    const { run } = await enqueue({ businessIds: [ids.agree!] });
    await drainQualificationQueue(db, "it-worker", { mx: mx(), env });
    const after = await db.researchFact.findUniqueOrThrow({ where: { id: osm.id } });
    expect(after).toMatchObject({
      verificationStatus: "invalid",
      verificationOverride: true,
      verificationMethod: "manual",
    });
    const web = await db.researchFact.findFirstOrThrow({
      where: { businessId: ids.agree, field: "phone", sourceType: "jsonld" },
    });
    expect(web.verificationStatus).toBe("unverified"); // lost its corroborating source
    const row = await db.businessQualification.findFirstOrThrow({ where: { runId: run.id } });
    expect(row.score).toBe(69 - 10); // verified phone 20 -> unverified phone 10
    expect((row.verification as { manual: number }).manual).toBe(1);

    const c = await clearFactOverride(db, {
      factId: osm.id,
      actorLabel: tag,
      reason: "re-checked",
    });
    expect(c).toMatchObject({
      verificationOverride: false,
      verificationStatus: "unverified",
      overrideReason: null,
    });
    expect(
      await db.auditLog.count({
        where: { action: "verification.override_clear", entityId: osm.id },
      }),
    ).toBe(1);
  });

  it("is idempotent and resumable: no duplicate rows on rerun", async () => {
    const key = `${tag}-idem`;
    const { run, created } = await enqueue({
      scopeType: "discovery_run",
      discoveryRunId,
      idempotencyKey: key,
    });
    expect(created).toBe(true);
    expect(
      await enqueue({ scopeType: "discovery_run", discoveryRunId, idempotencyKey: key }),
    ).toMatchObject({ created: false, run: { id: run.id } });
    const factsBefore = await db.researchFact.count({ where: { business: MOCK_ROWS } });
    expect(await claimNextQualificationRun(db, "crashy")).toBe(run.id);
    await expect(
      processQualificationRun(db, run.id, { mx: mx(), env, crashAfterBusinesses: 2 }),
    ).rejects.toThrow(/Simulated crash/);
    let r = await db.qualificationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(r).toMatchObject({ status: "running", processedCount: 2 });
    expect(await claimNextQualificationRun(db, "other")).toBeNull();
    expect(await claimNextQualificationRun(db, "other", 0)).toBe(run.id);
    await processQualificationRun(db, run.id, { mx: mx(), env });
    r = await db.qualificationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(r).toMatchObject({ status: "succeeded", processedCount: 6, totalCount: 6, attempts: 2 });
    expect(r.coldCount + r.disqualifiedCount).toBe(6);
    expect(await db.businessQualification.count({ where: { runId: run.id } })).toBe(6);
    // re-processing a finished run is a no-op; facts are never duplicated by verification
    expect(await processQualificationRun(db, run.id, { mx: mx(), env })).toBe("succeeded");
    expect(await db.businessQualification.count({ where: { runId: run.id } })).toBe(6);
    expect(await db.researchFact.count({ where: { business: MOCK_ROWS } })).toBe(factsBefore);
  });

  it("refuses Gemini until enabled, terms confirmed and key present; then records usage at cost 0", async () => {
    await db.providerConfig.update({
      where: { id: "gemini" },
      data: { enabled: false, commercialUseVerified: false, monthlyLimitUnits: null },
    });
    const one = [ids.agree!];
    const geminiEnv = { ...env, GEMINI_API_KEY: "test-key" };
    let { run } = await enqueue({ businessIds: one, ai: "gemini" });
    const calls: string[] = [];
    const fetchOk: ModelFetch = async (url) => {
      calls.push(url);
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      summary: "Sit-down restaurant, plain-HTTP site.",
                      pitchAngle: "Secure, mobile-friendly menu site.",
                      riskFlags: [{ code: "other", text: "x", factIds: ["not-a-fact"] }],
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 400, candidatesTokenCount: 50 },
        }),
        { status: 200 },
      );
    };
    const model = () => new GeminiModelProvider({ apiKey: "test-key", fetch: fetchOk });
    await drainQualificationQueue(db, "it-worker", { mx: mx(), env: geminiEnv, model: model() });
    let r = await db.qualificationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(r).toMatchObject({ status: "failed", processedCount: 0 });
    expect(r.error).toMatch(/disabled/);

    await db.providerConfig.update({
      where: { id: "gemini" },
      data: { enabled: true, commercialUseVerified: true },
    });
    ({ run } = await enqueue({ businessIds: one, ai: "gemini" }));
    await drainQualificationQueue(db, "it-worker", { mx: mx(), env, model: model() }); // no key in env
    r = await db.qualificationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/Missing secrets: GEMINI_API_KEY/);
    expect(calls).toHaveLength(0);

    ({ run } = await enqueue({ businessIds: one, ai: "gemini" }));
    await drainQualificationQueue(db, "it-worker", { mx: mx(), env: geminiEnv, model: model() });
    r = await db.qualificationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(r).toMatchObject({
      status: "succeeded",
      aiOkCount: 1,
      aiInputTokens: 400,
      aiOutputTokens: 50,
      aiCostMinor: 0,
    });
    const row = await db.businessQualification.findFirstOrThrow({ where: { runId: run.id } });
    expect(row).toMatchObject({
      aiStatus: "ok",
      aiProvider: "gemini",
      aiModel: "gemini-2.5-flash",
      aiIsMock: false,
      score: 69,
    });
    expect(row.aiRisks).toEqual([{ code: "other", text: "x", factIds: [] }]); // invented fact id dropped
    expect(row.aiError).toMatch(/Dropped 1 fact id/);
    const usage = await db.usageEvent.findFirstOrThrow({ where: { entityId: run.id } });
    expect(usage).toMatchObject({
      providerId: "gemini",
      units: 450,
      costMinor: 0,
      isEstimate: false,
    });

    // monthly limit reached: run fails before calling the API, nothing billed
    const month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const used = await db.usageEvent.aggregate({
      where: { providerId: "gemini", createdAt: { gte: month } },
      _sum: { units: true },
    });
    await db.providerConfig.update({
      where: { id: "gemini" },
      data: { monthlyLimitUnits: used._sum.units ?? 0 },
    });
    const before = calls.length;
    ({ run } = await enqueue({ businessIds: one, ai: "gemini" }));
    await drainQualificationQueue(db, "it-worker", { mx: mx(), env: geminiEnv, model: model() });
    r = await db.qualificationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/monthly limit/);
    expect(calls.length).toBe(before);
  });

  it("refuses the MOCK model in production", async () => {
    await expect(
      enqueueQualificationRun(
        db,
        { scopeType: "businesses", businessIds: [ids.agree!], ai: "mock", startedByLabel: tag },
        { APP_ENV: "production" },
      ),
    ).rejects.toThrow(/production/);
    const { run } = await enqueue({ businessIds: [ids.agree!], ai: "mock" });
    await drainQualificationQueue(db, "it-worker", { mx: mx(), env: { APP_ENV: "production" } });
    const r = await db.qualificationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(r).toMatchObject({ status: "failed", processedCount: 0 });
    expect(r.error).toMatch(/not allowed in production/);
  });
});
