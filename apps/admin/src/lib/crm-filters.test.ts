import { describe, expect, it } from "vitest";
import { parseLeadListFilter } from "@kalpix/core";
import { leadWhere } from "./crm-filters";

const ctx = { actorId: "u-me", now: new Date("2026-11-26T06:00:00.000Z"), staleDays: 14 };

describe("leadWhere", () => {
  it("is empty without filters", () => {
    expect(leadWhere(parseLeadListFilter({}), ctx)).toEqual({});
  });

  it("maps stage, assignee, tier, tag and contact status", () => {
    const w = leadWhere(
      parseLeadListFilter({
        stage: "contacted",
        assignee: "me",
        tier: "hot",
        tag: " VIP ",
        contactStatus: "ok",
      }),
      ctx,
    );
    expect(w).toEqual({
      AND: [
        { stage: "contacted" },
        { assigneeId: "u-me" },
        { business: { latestTier: "hot" } },
        { business: { contactStatus: "ok" } },
        { tags: { some: { tag: { key: "vip" } } } },
      ],
    });
    expect(leadWhere(parseLeadListFilter({ assignee: "none" }), ctx)).toEqual({
      AND: [{ assigneeId: null }],
    });
    expect(leadWhere(parseLeadListFilter({ assignee: "user-1" }), ctx)).toEqual({
      AND: [{ assigneeId: "user-1" }],
    });
  });

  it("overdue covers follow-ups on open leads and open tasks past due", () => {
    const w = leadWhere(parseLeadListFilter({ overdue: "yes" }), ctx);
    expect(w).toEqual({
      AND: [
        {
          OR: [
            { stage: { notIn: ["won", "lost"] }, nextFollowUpAt: { lt: ctx.now } },
            { tasks: { some: { status: "open", dueAt: { lt: ctx.now } } } },
          ],
        },
      ],
    });
  });

  it("stale uses CRM_STALE_DAYS and ignores won/lost", () => {
    const w = leadWhere(parseLeadListFilter({ stale: "true" }), ctx);
    expect(w).toEqual({
      AND: [
        {
          stage: { notIn: ["won", "lost"] },
          lastActivityAt: { lt: new Date("2026-11-12T06:00:00.000Z") },
        },
      ],
    });
  });

  it("q searches business name/phone and contacts", () => {
    const w = leadWhere(parseLeadListFilter({ q: "sagar" }), ctx) as { AND: { OR: unknown[] }[] };
    expect(w.AND[0]!.OR).toHaveLength(3);
    expect(JSON.stringify(w)).toContain('"mode":"insensitive"');
  });
});
