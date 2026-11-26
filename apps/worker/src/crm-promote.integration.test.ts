// Integration: real PostgreSQL (DATABASE_URL, migrated). Phase 6 lead promotion (idempotent,
// tiers, never disqualified / do-not-contact, round-robin, primary contact from verified facts)
// and the database guards of the CRM tables (append-only history and timeline, 15-minute note
// edits, lost reason, consent, tags, one primary contact). No network.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { roundRobinAssignees } from "@kalpix/core";
import {
  activeOperatorIds,
  CRM_ROUND_ROBIN_SETTING_KEY,
  promoteQualifiedLeads,
  PromoteError,
} from "./crm-promote";

const db = new PrismaClient();
const tag = `it-crm-${Date.now()}`;
const OWN = { provider: "it-crm" } as const;
const ids: Record<string, string> = {};
const userIds: string[] = [];
let qualRunId = "";
let priorCursor: unknown = undefined;
const actor = { label: tag };
const env = { CRM_PROMOTE_TIERS: "hot,warm" };

async function biz(key: string, tier: string | null, score: number | null, extra: object = {}) {
  const b = await db.business.create({
    data: {
      name: `IT CRM ${key}`,
      normalizedName: `it crm ${key}`,
      category: "restaurants",
      provider: OWN.provider,
      providerId: `${tag}/${key}`,
      lat: 15.85,
      lon: 74.5,
      source: "mock",
      sourceType: "mock",
      sourceUrl: `https://example.org/${tag}/${key}`,
      collectedAt: new Date(),
      lastSeenAt: new Date(),
      confidence: 0.5,
      latestTier: tier,
      latestScore: score,
      qualifiedAt: tier ? new Date() : null,
      ...extra,
    },
  });
  ids[key] = b.id;
  return b;
}

const fact = (businessId: string, field: string, value: string, verificationStatus: string) =>
  db.researchFact.create({
    data: {
      businessId,
      field,
      value,
      normalizedValue: value.toLowerCase(),
      sourceUrl: `https://example.org/${tag}`,
      sourceType: "jsonld",
      provider: "mock-research",
      collectedAt: new Date(),
      confidence: 0.8,
      verificationStatus,
    },
  });

beforeAll(async () => {
  priorCursor = (await db.systemSetting.findUnique({ where: { key: CRM_ROUND_ROBIN_SETTING_KEY } }))
    ?.value;
  for (const n of [1, 2]) {
    const u = await db.user.create({
      data: {
        id: `${tag}-op${n}`,
        name: `IT CRM op ${n}`,
        email: `${tag}-op${n}@kalpix.local`,
        role: "operator",
      },
    });
    userIds.push(u.id);
  }
  const hot = await biz("hot", "hot", 82);
  await biz("warm", "warm", 55);
  await biz("cold", "cold", 30);
  await biz("dq", "disqualified", 0);
  await biz("dnc", "hot", 90, {
    contactStatus: "do_not_contact",
    contactStatusReason: "Asked not to be called",
    contactStatusByLabel: tag,
    contactStatusAt: new Date(),
  });
  await biz("none", null, null);
  await fact(hot.id, "phone", "+919900000001", "unverified");
  await fact(hot.id, "phone", "+919900000002", "verified");
  await fact(hot.id, "email", "x@invalid.test", "invalid");
  await fact(hot.id, "whatsapp", "+919900000002", "verified");
  const run = await db.qualificationRun.create({
    data: {
      scopeType: "businesses",
      rulesVersion: "rules-v1",
      startedByLabel: tag,
      status: "succeeded",
    },
  });
  qualRunId = run.id;
  for (const [k, tier, score] of [
    ["hot", "hot", 82],
    ["warm", "warm", 55],
    ["cold", "cold", 30],
    ["dq", "disqualified", 0],
    ["dnc", "hot", 90],
  ] as const)
    await db.businessQualification.create({
      data: {
        runId: run.id,
        businessId: ids[k]!,
        rulesVersion: "rules-v1",
        score,
        tier,
        components: {},
        reasons: [],
        disqualifiedReason: tier === "disqualified" ? "closed" : null,
        operatingStatus: "no_evidence",
        verification: {},
      },
    });
});

afterAll(async () => {
  await db.business.deleteMany({ where: OWN }); // cascades leads, history, activity, contacts
  await db.qualificationRun.deleteMany({ where: { startedByLabel: tag } });
  await db.leadTag.deleteMany({ where: { key: { startsWith: tag } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  if (priorCursor === undefined)
    await db.systemSetting.deleteMany({ where: { key: CRM_ROUND_ROBIN_SETTING_KEY } });
  else
    await db.systemSetting.update({
      where: { key: CRM_ROUND_ROBIN_SETTING_KEY },
      data: { value: priorCursor as object },
    });
  await db.$disconnect();
});

describe("lead promotion", () => {
  it("promotes hot and warm from a qualification run, never disqualified or do-not-contact", async () => {
    const r = await promoteQualifiedLeads(
      db,
      { scope: { type: "qualification_run", runId: qualRunId }, actor },
      env,
    );
    expect(r.tiers).toEqual(["hot", "warm"]);
    expect(r.considered).toBe(5);
    expect(r.created.map((c) => c.businessId).sort()).toEqual([ids.hot, ids.warm].sort());
    expect(r.skipped).toEqual({
      has_lead: 0,
      tier_not_selected: 1,
      disqualified: 1,
      do_not_contact: 1,
    });
    const lead = await db.lead.findUniqueOrThrow({
      where: { businessId: ids.hot },
      include: { stageHistory: true, activities: true, contacts: true },
    });
    expect(lead).toMatchObject({
      stage: "new",
      source: "qualification",
      promotedTier: "hot",
      version: 1,
      assigneeId: null,
    });
    expect(lead.qualificationId).toBeTruthy();
    expect(lead.stageHistory).toHaveLength(1);
    expect(lead.stageHistory[0]).toMatchObject({ fromStage: null, toStage: "new", byLabel: tag });
    expect(lead.activities.map((a) => a.type)).toEqual(["system"]);
    expect(lead.contacts).toHaveLength(1);
    expect(lead.contacts[0]).toMatchObject({
      phone: "+919900000002",
      email: null,
      whatsapp: "+919900000002",
      isPrimary: true,
    });
    const verifiedPhone = await db.researchFact.findFirstOrThrow({
      where: { businessId: ids.hot, field: "phone", verificationStatus: "verified" },
    });
    expect(lead.contacts[0]!.sourceFactId).toBe(verifiedPhone.id);
    const warm = await db.lead.findUniqueOrThrow({
      where: { businessId: ids.warm },
      include: { contacts: true },
    });
    expect(warm.contacts).toHaveLength(0); // no usable facts: no empty contact row
    const audit = await db.auditLog.findFirst({
      where: { action: "crm.lead_promote", actorLabel: tag },
      orderBy: { createdAt: "desc" },
    });
    expect(audit?.metadata).toMatchObject({ created: 2, tiers: ["hot", "warm"] });
  });

  it("is idempotent: promoting again creates nothing", async () => {
    const r = await promoteQualifiedLeads(
      db,
      { scope: { type: "qualification_run", runId: qualRunId }, actor },
      env,
    );
    expect(r.created).toHaveLength(0);
    expect(r.skipped.has_lead).toBe(2);
    expect(await db.lead.count({ where: { business: OWN } })).toBe(2);
    // concurrent promotion of the same business: exactly one lead
    const both = await Promise.all([
      promoteQualifiedLeads(
        db,
        { scope: { type: "businesses", businessIds: [ids.cold!] }, tiers: ["cold"], actor },
        env,
      ),
      promoteQualifiedLeads(
        db,
        { scope: { type: "businesses", businessIds: [ids.cold!] }, tiers: ["cold"], actor },
        env,
      ),
    ]);
    expect(both.reduce((n, r) => n + r.created.length, 0)).toBe(1);
    expect(await db.lead.count({ where: { businessId: ids.cold } })).toBe(1);
  });

  it("refuses disqualified as a tier and unknown runs or businesses", async () => {
    await expect(
      promoteQualifiedLeads(
        db,
        { scope: { type: "all" }, tiers: ["disqualified" as never], actor },
        env,
      ),
    ).rejects.toBeInstanceOf(PromoteError);
    await expect(
      promoteQualifiedLeads(
        db,
        {
          scope: { type: "qualification_run", runId: "00000000-0000-0000-0000-000000000000" },
          actor,
        },
        env,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      promoteQualifiedLeads(
        db,
        {
          scope: { type: "businesses", businessIds: ["00000000-0000-0000-0000-000000000000"] },
          actor,
        },
        env,
      ),
    ).rejects.toMatchObject({ status: 404 });
    // disqualified business named explicitly is skipped, not promoted
    const r = await promoteQualifiedLeads(
      db,
      {
        scope: { type: "businesses", businessIds: [ids.dq!, ids.dnc!] },
        tiers: ["hot", "warm", "cold"],
        actor,
      },
      env,
    );
    expect(r.created).toHaveLength(0);
    expect(r.skipped).toMatchObject({ disqualified: 1, do_not_contact: 1 });
  });

  it("assigns round-robin across active operators and remembers the cursor", async () => {
    // fresh hot businesses for this test
    const keys = ["rr1", "rr2", "rr3"];
    for (const [i, k] of keys.entries()) await biz(k, "hot", 70 + i);
    const ops = await activeOperatorIds(db);
    expect(ops).toEqual(expect.arrayContaining(userIds));
    const before = (
      await db.systemSetting.findUnique({ where: { key: CRM_ROUND_ROBIN_SETTING_KEY } })
    )?.value as { lastUserId?: string } | undefined;
    const r = await promoteQualifiedLeads(
      db,
      {
        scope: { type: "businesses", businessIds: keys.map((k) => ids[k]!) },
        assign: "round_robin",
        actor,
      },
      env,
    );
    expect(r.created).toHaveLength(3);
    const expected = roundRobinAssignees(ops, before?.lastUserId ?? null, 3);
    expect(r.created.map((c) => c.assigneeId)).toEqual(expected);
    const cursor = (
      await db.systemSetting.findUniqueOrThrow({ where: { key: CRM_ROUND_ROBIN_SETTING_KEY } })
    ).value as { lastUserId: string };
    expect(cursor.lastUserId).toBe(expected[2]);
    const lead = await db.lead.findUniqueOrThrow({
      where: { businessId: ids.rr1 },
      include: { activities: true },
    });
    expect(lead.activities.map((a) => a.type).sort()).toEqual(["assignment", "system"]);
  });
});

describe("CRM database guards", () => {
  it("stage history is append-only", async () => {
    const lead = await db.lead.findUniqueOrThrow({ where: { businessId: ids.hot } });
    const h = await db.leadStageHistory.findFirstOrThrow({ where: { leadId: lead.id } });
    await expect(
      db.leadStageHistory.update({ where: { id: h.id }, data: { note: "x" } }),
    ).rejects.toThrow(/append-only/);
    await expect(db.leadStageHistory.delete({ where: { id: h.id } })).rejects.toThrow(
      /append-only/,
    );
  });

  it("timeline is append-only except a note body within 15 minutes", async () => {
    const lead = await db.lead.findUniqueOrThrow({ where: { businessId: ids.hot } });
    const sys = await db.leadActivity.findFirstOrThrow({
      where: { leadId: lead.id, type: "system" },
    });
    await expect(
      db.leadActivity.update({ where: { id: sys.id }, data: { body: "x", editedAt: new Date() } }),
    ).rejects.toThrow(/append-only/);
    const note = await db.leadActivity.create({
      data: { leadId: lead.id, type: "note", authorLabel: tag, body: "first" },
    });
    await expect(
      db.leadActivity.update({ where: { id: note.id }, data: { body: "no editedAt" } }),
    ).rejects.toThrow(/append-only/);
    const edited = await db.leadActivity.update({
      where: { id: note.id },
      data: { body: "second", editedAt: new Date() },
    });
    expect(edited.body).toBe("second");
    await expect(
      db.leadActivity.update({
        where: { id: note.id },
        data: { authorLabel: "someone", editedAt: new Date() },
      }),
    ).rejects.toThrow(/append-only/);
    const old = await db.leadActivity.create({
      data: {
        leadId: lead.id,
        type: "note",
        authorLabel: tag,
        body: "old",
        createdAt: new Date(Date.now() - 16 * 60_000),
      },
    });
    await expect(
      db.leadActivity.update({
        where: { id: old.id },
        data: { body: "late", editedAt: new Date() },
      }),
    ).rejects.toThrow(/15 minutes/);
    await expect(db.leadActivity.delete({ where: { id: note.id } })).rejects.toThrow(/append-only/);
  });

  it("lost needs a reason; consent needs who/why/when; tags and primaries are unique", async () => {
    const lead = await db.lead.findUniqueOrThrow({ where: { businessId: ids.warm } });
    await expect(
      db.lead.update({ where: { id: lead.id }, data: { stage: "lost" } }),
    ).rejects.toThrow(/lead_lost_reason_check/);
    await expect(
      db.lead.update({ where: { id: lead.id }, data: { valueEstimatePaise: -1 } }),
    ).rejects.toThrow(/lead_value_check/);
    await expect(
      db.business.update({ where: { id: ids.warm }, data: { contactStatus: "opted_out" } }),
    ).rejects.toThrow(/business_contact_status_check/);
    await db.leadTag.create({ data: { name: `${tag} VIP`, key: `${tag} vip` } });
    await expect(
      db.leadTag.create({ data: { name: `${tag} vip`, key: `${tag} vip` } }),
    ).rejects.toThrow();
    await expect(
      db.leadTag.create({ data: { name: `${tag} X`, key: `${tag} X` } }),
    ).rejects.toThrow(/lead_tag_key_check/);
    await db.leadContact.create({ data: { leadId: lead.id, personName: "A", isPrimary: true } });
    await expect(
      db.leadContact.create({ data: { leadId: lead.id, personName: "B", isPrimary: true } }),
    ).rejects.toThrow();
    await expect(db.leadContact.create({ data: { leadId: lead.id } })).rejects.toThrow(
      /lead_contact_nonempty_check/,
    );
    await expect(
      db.leadTask.create({
        data: { leadId: lead.id, title: "t", createdByLabel: tag, status: "done" },
      }),
    ).rejects.toThrow(/lead_task_completed_check/);
  });

  it("deleting a business cascades its lead and the append-only rows", async () => {
    const b = await biz("cascade", "hot", 75);
    await promoteQualifiedLeads(
      db,
      { scope: { type: "businesses", businessIds: [b.id] }, actor },
      env,
    );
    const lead = await db.lead.findUniqueOrThrow({ where: { businessId: b.id } });
    await db.leadActivity.create({
      data: { leadId: lead.id, type: "note", authorLabel: tag, body: "n" },
    });
    await db.business.delete({ where: { id: b.id } });
    expect(await db.leadStageHistory.count({ where: { leadId: lead.id } })).toBe(0);
    expect(await db.leadActivity.count({ where: { leadId: lead.id } })).toBe(0);
  });

  it("a user deletion nulls authorship on append-only rows (SET NULL passes the guard)", async () => {
    const u = await db.user.create({
      data: { id: `${tag}-tmp`, name: "tmp", email: `${tag}-tmp@kalpix.local`, role: "operator" },
    });
    const lead = await db.lead.findUniqueOrThrow({ where: { businessId: ids.hot } });
    const a = await db.leadActivity.create({
      data: {
        leadId: lead.id,
        type: "call_logged",
        authorId: u.id,
        authorLabel: u.email,
        body: "called",
      },
    });
    await db.user.delete({ where: { id: u.id } });
    expect((await db.leadActivity.findUniqueOrThrow({ where: { id: a.id } })).authorId).toBeNull();
  });
});
