import { describe, expect, it } from "vitest";
import {
  allowedNextStages,
  businessNameKey,
  canEditActivity,
  checkStageTransition,
  crmSettingsFromEnv,
  findExistingBusiness,
  isFollowUpOverdue,
  isTaskOverdue,
  LEAD_STAGES,
  leadHealth,
  normalizeLeadPhone,
  normalizeTagList,
  parseCsv,
  parseLeadImport,
  parseLeadListFilter,
  parsePromoteTiers,
  planPromotion,
  primaryContactFromFacts,
  roundRobinAssignees,
  STAGE_TRANSITIONS,
  tagKey,
  type LeadStage,
} from "./crm";

const NOW = new Date("2026-11-26T06:00:00.000Z");
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const move = (
  from: LeadStage,
  to: string,
  extra: Partial<Parameters<typeof checkStageTransition>[0]> = {},
) => checkStageTransition({ from, to, contactStatus: "ok", canReopen: false, ...extra });

describe("stage transitions", () => {
  it("allows the normal forward path", () => {
    const path: LeadStage[] = [
      "new",
      "contacted",
      "interested",
      "demo_requested",
      "proposal_sent",
      "negotiating",
      "won",
    ];
    for (let i = 1; i < path.length; i++) expect(move(path[i - 1]!, path[i]!).ok).toBe(true);
  });

  it("refuses moves outside the matrix, the same stage and unknown stages", () => {
    expect(move("new", "won")).toMatchObject({ ok: false, code: "not_allowed" });
    expect(move("new", "proposal_sent")).toMatchObject({ ok: false, code: "not_allowed" });
    expect(move("contacted", "contacted")).toMatchObject({ ok: false, code: "same_stage" });
    expect(move("new", "closed")).toMatchObject({ ok: false, code: "unknown_stage" });
  });

  it("every open stage can go to lost (with a reason) and nurture, except nurture itself", () => {
    for (const s of LEAD_STAGES.filter((x) => x !== "won" && x !== "lost")) {
      expect(move(s, "lost", { lostReason: "Chose another agency" }).ok).toBe(true);
      if (s !== "nurture") expect(move(s, "nurture").ok).toBe(true);
    }
  });

  it("lost requires a reason of 3-500 characters", () => {
    expect(move("contacted", "lost")).toMatchObject({ code: "lost_reason_required" });
    expect(move("contacted", "lost", { lostReason: "  " })).toMatchObject({
      code: "lost_reason_required",
    });
    expect(move("contacted", "lost", { lostReason: "x".repeat(501) })).toMatchObject({
      code: "lost_reason_required",
    });
    expect(move("contacted", "lost", { lostReason: "No budget" }).ok).toBe(true);
  });

  it("won and lost are terminal: reopen only to nurture/contacted, only by admin+", () => {
    expect(STAGE_TRANSITIONS.won).toEqual([]);
    expect(move("won", "nurture")).toMatchObject({ code: "reopen_requires_admin" });
    expect(move("lost", "contacted")).toMatchObject({ code: "reopen_requires_admin" });
    expect(move("won", "nurture", { canReopen: true })).toEqual({ ok: true, reopen: true });
    expect(move("lost", "contacted", { canReopen: true })).toEqual({ ok: true, reopen: true });
    expect(move("lost", "negotiating", { canReopen: true })).toMatchObject({ code: "not_allowed" });
    expect(move("won", "lost", { canReopen: true, lostReason: "Refund" })).toMatchObject({
      code: "not_allowed",
    });
  });

  it("do-not-contact and opted-out leads cannot enter outreach stages", () => {
    for (const contactStatus of ["do_not_contact", "opted_out"] as const) {
      expect(move("new", "contacted", { contactStatus })).toMatchObject({
        code: "do_not_contact",
      });
      expect(move("contacted", "demo_requested", { contactStatus })).toMatchObject({
        code: "do_not_contact",
      });
      expect(move("interested", "proposal_sent", { contactStatus })).toMatchObject({
        code: "do_not_contact",
      });
      expect(move("proposal_sent", "negotiating", { contactStatus })).toMatchObject({
        code: "do_not_contact",
      });
      expect(move("lost", "contacted", { contactStatus, canReopen: true })).toMatchObject({
        code: "do_not_contact",
      });
      // winding down is still allowed
      expect(move("contacted", "nurture", { contactStatus }).ok).toBe(true);
      expect(move("contacted", "lost", { contactStatus, lostReason: "Opted out" }).ok).toBe(true);
      expect(move("lost", "nurture", { contactStatus, canReopen: true }).ok).toBe(true);
    }
  });

  it("lists allowed next stages for the UI", () => {
    expect(allowedNextStages("new", "ok", false)).toEqual([
      "contacted",
      "interested",
      "lost",
      "nurture",
    ]);
    expect(allowedNextStages("new", "do_not_contact", false)).toEqual([
      "interested",
      "lost",
      "nurture",
    ]);
    expect(allowedNextStages("won", "ok", false)).toEqual([]);
    expect(allowedNextStages("won", "ok", true)).toEqual(["contacted", "nurture"]);
  });
});

describe("follow-up, health and note editing", () => {
  it("overdue follow-ups only for open leads with a past time", () => {
    expect(isFollowUpOverdue({ stage: "contacted", nextFollowUpAt: days(1) }, NOW)).toBe(true);
    expect(isFollowUpOverdue({ stage: "contacted", nextFollowUpAt: days(-1) }, NOW)).toBe(false);
    expect(isFollowUpOverdue({ stage: "contacted", nextFollowUpAt: null }, NOW)).toBe(false);
    expect(isFollowUpOverdue({ stage: "won", nextFollowUpAt: days(3) }, NOW)).toBe(false);
    expect(isTaskOverdue({ status: "open", dueAt: days(1) }, NOW)).toBe(true);
    expect(isTaskOverdue({ status: "done", dueAt: days(1) }, NOW)).toBe(false);
    expect(isTaskOverdue({ status: "open", dueAt: null }, NOW)).toBe(false);
  });

  it("health: stale after N days without activity, closed for won/lost", () => {
    expect(leadHealth({ stage: "new", lastActivityAt: days(13) }, NOW, 14)).toEqual({
      health: "active",
      daysSinceActivity: 13,
    });
    expect(leadHealth({ stage: "new", lastActivityAt: days(14) }, NOW, 14).health).toBe("stale");
    expect(leadHealth({ stage: "new", lastActivityAt: days(3) }, NOW, 2).health).toBe("stale");
    expect(leadHealth({ stage: "lost", lastActivityAt: days(90) }, NOW).health).toBe("closed");
    expect(leadHealth({ stage: "new", lastActivityAt: days(-1) }, NOW).daysSinceActivity).toBe(0);
  });

  it("only the author edits a note, within 15 minutes", () => {
    const note = {
      type: "note" as const,
      authorId: "u1",
      createdAt: new Date(NOW.getTime() - 60_000),
    };
    expect(canEditActivity(note, "u1", NOW).ok).toBe(true);
    expect(canEditActivity(note, "u2", NOW).ok).toBe(false);
    expect(canEditActivity({ ...note, type: "call_logged" }, "u1", NOW).ok).toBe(false);
    expect(
      canEditActivity({ ...note, createdAt: new Date(NOW.getTime() - 16 * 60_000) }, "u1", NOW).ok,
    ).toBe(false);
    expect(canEditActivity({ ...note, authorId: null }, "u1", NOW).ok).toBe(false);
  });
});

describe("tags", () => {
  it("are unique case-insensitively and validated", () => {
    expect(tagKey("  Follow  Up ")).toBe("follow up");
    expect(normalizeTagList(["VIP", "vip", " Belagavi ", "follow-up"])).toEqual([
      "VIP",
      "Belagavi",
      "follow-up",
    ]);
    expect(() => normalizeTagList([""])).toThrow();
    expect(() => normalizeTagList(["=cmd()"])).toThrow();
    expect(() => normalizeTagList(["x".repeat(41)])).toThrow();
  });
});

describe("configuration", () => {
  it("defaults to 14 days and hot,warm", () => {
    expect(crmSettingsFromEnv({})).toEqual({ staleDays: 14, promoteTiers: ["hot", "warm"] });
    expect(crmSettingsFromEnv({ CRM_STALE_DAYS: " ", CRM_PROMOTE_TIERS: "" })).toEqual({
      staleDays: 14,
      promoteTiers: ["hot", "warm"],
    });
  });
  it("parses and validates overrides; disqualified is never promotable", () => {
    expect(crmSettingsFromEnv({ CRM_STALE_DAYS: "30", CRM_PROMOTE_TIERS: "HOT, cold" })).toEqual({
      staleDays: 30,
      promoteTiers: ["hot", "cold"],
    });
    expect(() => crmSettingsFromEnv({ CRM_STALE_DAYS: "0" })).toThrow(/CRM_STALE_DAYS/);
    expect(() => crmSettingsFromEnv({ CRM_STALE_DAYS: "1.5" })).toThrow(/CRM_STALE_DAYS/);
    expect(() => parsePromoteTiers("hot,disqualified")).toThrow(/disqualified never/);
    expect(() => parsePromoteTiers("lukewarm")).toThrow(/CRM_PROMOTE_TIERS/);
  });
});

describe("promotion planning", () => {
  const c = (businessId: string, tier: string | null, extra = {}) => ({
    businessId,
    tier,
    contactStatus: "ok" as const,
    hasLead: false,
    ...extra,
  });
  it("promotes selected tiers only, never disqualified, existing leads or DNC", () => {
    const { promote, skipped } = planPromotion(
      [
        c("a", "hot"),
        c("b", "warm"),
        c("c", "cold"),
        c("d", "disqualified"),
        c("e", "hot", { hasLead: true }),
        c("f", "warm", { contactStatus: "opted_out" }),
        c("g", null),
        c("a", "hot"),
      ],
      ["hot", "warm"],
    );
    expect(promote.map((p) => p.businessId)).toEqual(["a", "b"]);
    expect(Object.fromEntries(skipped.map((s) => [s.businessId, s.reason]))).toEqual({
      c: "tier_not_selected",
      d: "disqualified",
      e: "has_lead",
      f: "do_not_contact",
      g: "tier_not_selected",
    });
    expect(planPromotion([c("c", "cold")], ["cold"]).promote).toHaveLength(1);
  });

  it("round-robins after the last assignee", () => {
    expect(roundRobinAssignees(["u3", "u1", "u2"], null, 4)).toEqual(["u1", "u2", "u3", "u1"]);
    expect(roundRobinAssignees(["u1", "u2", "u3"], "u2", 2)).toEqual(["u3", "u1"]);
    expect(roundRobinAssignees(["u1", "u2"], "u9", 1)).toEqual(["u1"]);
    expect(roundRobinAssignees([], "u1", 2)).toEqual([null, null]);
  });

  it("builds a primary contact from the best facts, never invalid ones", () => {
    const fact = (
      id: string,
      field: string,
      value: string,
      verificationStatus: string,
      confidence = 0.8,
    ) => ({
      id,
      field,
      value,
      verificationStatus,
      confidence,
    });
    expect(
      primaryContactFromFacts([
        fact("f1", "phone", "+919900000001", "unverified", 0.9),
        fact("f2", "phone", "+919900000002", "verified", 0.7),
        fact("f3", "email", "bad@x.test", "invalid"),
        fact("f4", "whatsapp", "+919900000003", "conflicting"),
      ]),
    ).toEqual({
      phone: "+919900000002",
      email: null,
      whatsapp: "+919900000003",
      sourceFactId: "f2",
    });
    expect(primaryContactFromFacts([fact("f3", "email", "bad@x.test", "invalid")])).toBeNull();
  });
});

describe("CSV import", () => {
  it("parses RFC 4180 CSV", () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi"""\n\n1,\n')).toEqual([
      ["a", "b"],
      ["x, y", 'he said "hi"'],
      ["1", ""],
    ]);
    expect(() => parseCsv('a\n"open')).toThrow(/unterminated/);
  });

  it("normalises Indian phone numbers", () => {
    expect(normalizeLeadPhone("098450 12345")).toBe("+919845012345");
    expect(normalizeLeadPhone("9845012345")).toBe("+919845012345");
    expect(normalizeLeadPhone("+91 831 246 1234")).toBe("+918312461234");
    expect(normalizeLeadPhone("0831-2461234")).toBe("+918312461234");
    expect(normalizeLeadPhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizeLeadPhone("12345")).toBeNull();
    expect(normalizeLeadPhone("+91 0123456789")).toBeNull();
    expect(normalizeLeadPhone("")).toBeNull();
  });

  it("validates rows and reports line numbers", () => {
    const csv = [
      "Name,Category,Phone,Email,Postcode,lat,lon,priority,value_estimate_paise,tags",
      "Hotel Sagar,restaurants,9845012345,,590006,15.85,74.5,high,2500000,VIP;belagavi",
      "Bad Cat,bakery,9845012346,,,,,,,",
      "No Channel,retail,,,,,,,,",
      "Bad Phone,retail,123,,,,,,,",
      "Half Geo,retail,9845012347,,,15.8,,,,",
      "Money,retail,9845012348,,,,,,12.5,",
      "Dup By Phone,retail,+91 98450 12345,,,,,,,",
      "hotel sagar pvt ltd,restaurants,,a@b.in,590006,,,,,",
      "Mail Only,clinics,,Hello@Clinic.IN,,,,low,,",
    ].join("\n");
    const { rows, errors } = parseLeadImport(csv);
    expect(rows.map((r) => r.line)).toEqual([2, 10]);
    expect(rows[0]!.row).toMatchObject({
      name: "Hotel Sagar",
      category: "restaurants",
      phone: "+919845012345",
      postcode: "590006",
      lat: 15.85,
      lon: 74.5,
      priority: "high",
      value_estimate_paise: 2500000,
      tags: ["VIP", "belagavi"],
    });
    expect(rows[1]!.row).toMatchObject({ email: "hello@clinic.in", priority: "low", tags: [] });
    const byLine = Object.fromEntries(errors.map((e) => [e.line, e.message]));
    expect(byLine[3]).toMatch(/category/);
    expect(byLine[4]).toMatch(/at least one of phone, email or whatsapp/);
    expect(byLine[5]).toMatch(/valid phone/);
    expect(byLine[6]).toMatch(/both lat and lon/);
    expect(byLine[7]).toMatch(/whole number of paise/);
    expect(byLine[8]).toMatch(/Duplicate of line 2/);
    expect(byLine[9]).toMatch(/Duplicate of line 2/);
  });

  it("rejects bad headers and oversize files", () => {
    expect(parseLeadImport("name,categry\nA,retail").errors[0]?.message).toMatch(/Unknown column/);
    expect(parseLeadImport("phone\n9845012345").errors[0]?.message).toMatch(/Missing column/);
    expect(parseLeadImport("").errors[0]?.message).toMatch(/empty/);
    const big = [
      "name,category,phone",
      ...Array.from({ length: 3 }, (_, i) => `B${i},retail,98450123${40 + i}`),
    ];
    expect(parseLeadImport(big.join("\n"), 2).errors[0]?.message).toMatch(/At most 2 rows/);
  });

  it("dedupes against existing businesses by phone or name + PIN", () => {
    const existing = [
      { id: "b1", name: "Hotel Sagar Pvt Ltd", phone: "+91 98450 12345", postcode: "590006" },
      { id: "b2", name: "Sagar Clinic", phone: null, postcode: "590001" },
    ];
    expect(findExistingBusiness({ name: "Other", phone: "09845012345" }, existing)).toMatchObject({
      business: { id: "b1" },
      by: "phone",
    });
    expect(
      findExistingBusiness({ name: "SAGAR CLINIC", postcode: "590001" }, existing),
    ).toMatchObject({ business: { id: "b2" }, by: "name_postcode" });
    expect(findExistingBusiness({ name: "Sagar Clinic", postcode: "590002" }, existing)).toBeNull();
    expect(businessNameKey("The Café & Bakery Pvt. Ltd.")).toBe("cafe bakery");
  });
});

describe("list filters", () => {
  it("parses query strings and rejects junk", () => {
    expect(parseLeadListFilter({})).toEqual({ page: 1 });
    expect(
      parseLeadListFilter({
        stage: "contacted",
        assignee: "me",
        tier: "hot",
        tag: "VIP",
        overdue: "yes",
        q: " sagar ",
        page: "3",
      }),
    ).toEqual({
      stage: "contacted",
      assignee: "me",
      tier: "hot",
      tag: "VIP",
      overdue: true,
      q: "sagar",
      page: 3,
    });
    expect(() => parseLeadListFilter({ stage: "closed" })).toThrow();
    expect(() => parseLeadListFilter({ overdue: "maybe" })).toThrow();
    expect(() => parseLeadListFilter({ page: "0" })).toThrow();
    expect(() => parseLeadListFilter({ assignee: "x'; drop" })).toThrow();
  });
});
