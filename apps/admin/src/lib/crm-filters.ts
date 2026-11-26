import type { Prisma } from "@prisma/client";
import { staleCutoff, tagKey, TERMINAL_STAGES, type LeadListFilter } from "@kalpix/core";

const OPEN = { notIn: [...TERMINAL_STAGES] };

/**
 * Prisma where-clause for the CRM lead list and CSV export (same filters, so an export is exactly
 * what the list shows). overdue = an open lead whose follow-up time has passed, or which has an
 * open task past its due time. stale = open with no activity since CRM_STALE_DAYS.
 */
export function leadWhere(
  f: Omit<LeadListFilter, "page">,
  ctx: { actorId: string; now: Date; staleDays: number },
): Prisma.LeadWhereInput {
  const and: Prisma.LeadWhereInput[] = [];
  if (f.stage) and.push({ stage: f.stage });
  if (f.assignee === "me") and.push({ assigneeId: ctx.actorId });
  else if (f.assignee === "none") and.push({ assigneeId: null });
  else if (f.assignee) and.push({ assigneeId: f.assignee });
  if (f.tier) and.push({ business: { latestTier: f.tier } });
  if (f.contactStatus) and.push({ business: { contactStatus: f.contactStatus } });
  if (f.tag) and.push({ tags: { some: { tag: { key: tagKey(f.tag) } } } });
  if (f.overdue === true)
    and.push({
      OR: [
        { stage: OPEN, nextFollowUpAt: { lt: ctx.now } },
        { tasks: { some: { status: "open", dueAt: { lt: ctx.now } } } },
      ],
    });
  else if (f.overdue === false)
    and.push({
      NOT: {
        OR: [
          { stage: OPEN, nextFollowUpAt: { lt: ctx.now } },
          { tasks: { some: { status: "open", dueAt: { lt: ctx.now } } } },
        ],
      },
    });
  if (f.stale === true)
    and.push({ stage: OPEN, lastActivityAt: { lt: staleCutoff(ctx.now, ctx.staleDays) } });
  else if (f.stale === false)
    and.push({
      OR: [
        { stage: { in: [...TERMINAL_STAGES] } },
        { lastActivityAt: { gte: staleCutoff(ctx.now, ctx.staleDays) } },
      ],
    });
  if (f.q) {
    const q = f.q;
    and.push({
      OR: [
        { business: { name: { contains: q, mode: "insensitive" } } },
        { business: { phone: { contains: q } } },
        {
          contacts: {
            some: {
              OR: [
                { personName: { contains: q, mode: "insensitive" } },
                { phone: { contains: q } },
                { email: { contains: q, mode: "insensitive" } },
              ],
            },
          },
        },
      ],
    });
  }
  return and.length ? { AND: and } : {};
}

export const LEAD_LIST_ORDER: Prisma.LeadOrderByWithRelationInput[] = [
  { nextFollowUpAt: { sort: "asc", nulls: "last" } },
  { createdAt: "desc" },
  { id: "asc" },
];
