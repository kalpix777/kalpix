import "server-only";
import { headers } from "next/headers";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  allowedNextStages,
  canEditActivity,
  checkStageTransition,
  CONTACT_STATUSES,
  CRM_EXPORT_MAX_ROWS,
  CRM_MAX_PROMOTE,
  CRM_PAGE_SIZE,
  crmSettingsFromEnv,
  findExistingBusiness,
  isFollowUpOverdue,
  LEAD_PRIORITIES,
  LEAD_STAGES,
  leadHealth,
  MANUAL_ACTIVITY_TYPES,
  normalizeLeadPhone,
  normalizeTagList,
  parseLeadImport,
  PROMOTABLE_TIERS,
  tagKey,
  type ContactStatus,
  type LeadListFilter,
  type LeadStage,
} from "@kalpix/core";
import { normalizeName, toCsv } from "@kalpix/providers";
import { promoteQualifiedLeads, PromoteError } from "@kalpix/worker/crm-promote";
import { db } from "@/lib/db";
import { LEAD_LIST_ORDER, leadWhere } from "@/lib/crm-filters";
import { can, type Permission } from "@/lib/rbac";

// ---------------- shared ----------------

export interface Actor {
  id: string;
  email: string;
  role?: string | null;
}

export class CrmError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function need(actor: Actor, permission: Permission, what: string) {
  if (!can(actor.role, permission))
    throw new CrmError(`You do not have permission to ${what}`, 403);
}

async function clientIp() {
  try {
    return (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined;
  } catch {
    return undefined;
  }
}

export function crmSettings() {
  return crmSettingsFromEnv(process.env);
}

const id = z.string().regex(/^[0-9a-f-]{36}$/i, "Must be an id");
const userId = z.string().trim().min(1).max(64);
const version = z.number().int().min(1);
const isoDate = z.iso.datetime({ offset: true }).transform((v) => new Date(v));
const paise = z.number().int().min(0).max(2_000_000_000);
const text = (min: number, max: number) => z.string().trim().min(min).max(max);

/** Parses a route/action id; an invalid id is a 404 like an unknown one. */
export function parseId(raw: unknown): string {
  const r = id.safeParse(raw);
  if (!r.success) throw new CrmError("Not found", 404);
  return r.data;
}

const now = () => new Date();

/**
 * Optimistic concurrency: updates the lead only when `expected` is still its version, bumping it.
 * A missing lead is 404; a stale version is 409 with the current version.
 */
async function bumpLead(
  tx: Prisma.TransactionClient,
  leadId: string,
  expected: number,
  data: Prisma.LeadUncheckedUpdateManyInput,
) {
  const r = await tx.lead.updateMany({
    where: { id: leadId, version: expected },
    data: { ...data, version: { increment: 1 } },
  });
  if (r.count === 1) return;
  const cur = await tx.lead.findUnique({ where: { id: leadId }, select: { version: true } });
  if (!cur) throw new CrmError("Lead not found", 404);
  throw new CrmError("This lead was changed by someone else. Reload and try again.", 409, {
    currentVersion: cur.version,
  });
}

async function loadLead(tx: Prisma.TransactionClient, leadId: string) {
  const lead = await tx.lead.findUnique({
    where: { id: leadId },
    include: { business: { select: { id: true, name: true, contactStatus: true } } },
  });
  if (!lead) throw new CrmError("Lead not found", 404);
  return lead;
}

/** An assignee must be an active user who can work leads (operator, admin, owner). */
async function checkAssignee(tx: Prisma.TransactionClient, uid: string) {
  const u = await tx.user.findUnique({
    where: { id: uid },
    select: { id: true, email: true, role: true, banned: true },
  });
  if (!u || u.banned) throw new CrmError("Assignee not found or suspended", 400);
  if (!can(u.role, "crm:write"))
    throw new CrmError("Assignee must be an operator, admin or owner", 400);
  return u;
}

// ---------------- list / detail ----------------

export async function listLeads(actor: Actor, filter: LeadListFilter) {
  need(actor, "crm:read", "read leads");
  const t = now();
  const { staleDays } = crmSettings();
  const where = leadWhere(filter, { actorId: actor.id, now: t, staleDays });
  const [total, rows] = await Promise.all([
    db.lead.count({ where }),
    db.lead.findMany({
      where,
      orderBy: LEAD_LIST_ORDER,
      skip: (filter.page - 1) * CRM_PAGE_SIZE,
      take: CRM_PAGE_SIZE,
      include: {
        business: {
          select: {
            id: true,
            name: true,
            category: true,
            city: true,
            latestTier: true,
            latestScore: true,
            contactStatus: true,
          },
        },
        assignee: { select: { id: true, name: true, email: true } },
        tags: { select: { tag: { select: { name: true } } } },
        _count: {
          select: {
            tasks: { where: { status: "open" } },
          },
        },
      },
    }),
  ]);
  const overdueTasks = rows.length
    ? await db.leadTask.groupBy({
        by: ["leadId"],
        where: { leadId: { in: rows.map((r) => r.id) }, status: "open", dueAt: { lt: t } },
        _count: { _all: true },
      })
    : [];
  const overdueBy = new Map(overdueTasks.map((o) => [o.leadId, o._count._all]));
  return {
    page: filter.page,
    pageSize: CRM_PAGE_SIZE,
    total,
    staleDays,
    leads: rows.map((l) => {
      const { health, daysSinceActivity } = leadHealth(l, t, staleDays);
      const overdueTaskCount = overdueBy.get(l.id) ?? 0;
      return {
        id: l.id,
        version: l.version,
        stage: l.stage,
        priority: l.priority,
        source: l.source,
        valueEstimatePaise: l.valueEstimatePaise,
        currency: l.currency,
        nextFollowUpAt: l.nextFollowUpAt,
        followUpOverdue: isFollowUpOverdue(l, t),
        openTaskCount: l._count.tasks,
        overdueTaskCount,
        overdue: isFollowUpOverdue(l, t) || overdueTaskCount > 0,
        health,
        daysSinceActivity,
        lastActivityAt: l.lastActivityAt,
        stageChangedAt: l.stageChangedAt,
        createdAt: l.createdAt,
        updatedAt: l.updatedAt,
        assignee: l.assignee,
        business: l.business,
        tags: l.tags.map((t) => t.tag.name),
      };
    }),
  };
}

/** Pipeline summary for the CRM page: lead counts per stage plus overdue and stale (open) counts. */
export async function pipelineSummary(actor: Actor) {
  need(actor, "crm:read", "read leads");
  const t = now();
  const { staleDays } = crmSettings();
  const base = { actorId: actor.id, now: t, staleDays };
  const [groups, overdue, stale, dnc] = await Promise.all([
    db.lead.groupBy({ by: ["stage"], _count: { _all: true } }),
    db.lead.count({ where: leadWhere({ overdue: true }, base) }),
    db.lead.count({ where: leadWhere({ stale: true }, base) }),
    db.lead.count({ where: { business: { contactStatus: { not: "ok" } } } }),
  ]);
  const byStage = Object.fromEntries(LEAD_STAGES.map((s) => [s, 0])) as Record<LeadStage, number>;
  for (const g of groups) byStage[g.stage as LeadStage] = g._count._all;
  const total = Object.values(byStage).reduce((a, b) => a + b, 0);
  return { byStage, total, overdue, stale, doNotContact: dnc, staleDays };
}

export async function getLead(actor: Actor, leadId: string) {
  need(actor, "crm:read", "read leads");
  const t = now();
  const { staleDays } = crmSettings();
  const l = await db.lead.findUnique({
    where: { id: leadId },
    include: {
      business: {
        select: {
          id: true,
          name: true,
          category: true,
          phone: true,
          email: true,
          website: true,
          addressFull: true,
          city: true,
          postcode: true,
          latestTier: true,
          latestScore: true,
          qualifiedAt: true,
          contactStatus: true,
          contactStatusReason: true,
          contactStatusByLabel: true,
          contactStatusAt: true,
          lawfulBasisNote: true,
        },
      },
      assignee: { select: { id: true, name: true, email: true } },
      tags: { select: { tag: { select: { id: true, name: true } } } },
      contacts: {
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
        include: {
          sourceFact: {
            select: {
              id: true,
              field: true,
              sourceUrl: true,
              sourceType: true,
              verificationStatus: true,
            },
          },
        },
      },
      tasks: {
        orderBy: [
          { status: "asc" },
          { dueAt: { sort: "asc", nulls: "last" } },
          { createdAt: "asc" },
        ],
        include: { assignee: { select: { id: true, name: true, email: true } } },
      },
      stageHistory: { orderBy: { at: "asc" } },
      activities: { orderBy: { createdAt: "desc" }, take: 200 },
    },
  });
  if (!l) throw new CrmError("Lead not found", 404);
  const { health, daysSinceActivity } = leadHealth(l, t, staleDays);
  const editableUntil = (a: { type: string; authorId: string | null; createdAt: Date }) =>
    a.type === "note" && a.authorId === actor.id
      ? new Date(a.createdAt.getTime() + 15 * 60_000)
      : null;
  return {
    ...l,
    tags: l.tags.map((x) => x.tag),
    tasks: l.tasks.map((k) => ({
      ...k,
      overdue: k.status === "open" && k.dueAt !== null && k.dueAt < t,
    })),
    activities: l.activities.map((a) => ({
      ...a,
      editableUntil:
        canEditActivity(a, actor.id, t).ok && can(actor.role, "crm:write")
          ? editableUntil(a)
          : null,
    })),
    health,
    daysSinceActivity,
    staleDays,
    followUpOverdue: isFollowUpOverdue(l, t),
    allowedNextStages: can(actor.role, "crm:write")
      ? allowedNextStages(l.stage, l.business.contactStatus, can(actor.role, "crm:reopen"))
      : [],
  };
}

// ---------------- create: promote / manual ----------------

export const promoteSchema = z.discriminatedUnion("scope", [
  z.object({
    scope: z.literal("qualification_run"),
    runId: id,
    tiers: z.array(z.enum(PROMOTABLE_TIERS)).min(1).optional(),
    assign: z.enum(["none", "round_robin"]).default("none"),
    limit: z.number().int().min(1).max(CRM_MAX_PROMOTE).optional(),
  }),
  z.object({
    scope: z.literal("businesses"),
    businessIds: z.array(id).min(1).max(CRM_MAX_PROMOTE),
    tiers: z.array(z.enum(PROMOTABLE_TIERS)).min(1).optional(),
    assign: z.enum(["none", "round_robin"]).default("none"),
  }),
  z.object({
    scope: z.literal("all"),
    tiers: z.array(z.enum(PROMOTABLE_TIERS)).min(1).optional(),
    assign: z.enum(["none", "round_robin"]).default("none"),
    limit: z.number().int().min(1).max(CRM_MAX_PROMOTE).default(200),
  }),
  z.object({
    scope: z.literal("manual"),
    businessId: id,
    assigneeId: userId.nullable().optional(),
    priority: z.enum(LEAD_PRIORITIES).default("normal"),
    note: text(1, 2000).optional(),
  }),
]);

/** POST /api/crm/leads: promote from qualification (idempotent) or create one manual lead. */
export async function createLeads(actor: Actor, raw: unknown) {
  need(actor, "crm:write", "create leads");
  const input = promoteSchema.parse(raw);
  const ipAddress = await clientIp();
  if (input.scope === "manual") return { manual: await createManualLead(actor, input, ipAddress) };
  try {
    const scope =
      input.scope === "qualification_run"
        ? ({ type: "qualification_run", runId: input.runId } as const)
        : input.scope === "businesses"
          ? ({ type: "businesses", businessIds: input.businessIds } as const)
          : ({ type: "all" } as const);
    const result = await promoteQualifiedLeads(
      db,
      {
        scope,
        tiers: input.tiers,
        assign: input.assign,
        limit: "limit" in input ? input.limit : undefined,
        actor: { id: actor.id, label: actor.email },
        ipAddress,
      },
      process.env,
    );
    return { promoted: result };
  } catch (err) {
    if (err instanceof PromoteError) throw new CrmError(err.message, err.status);
    throw err;
  }
}

async function createManualLead(
  actor: Actor,
  input: Extract<z.infer<typeof promoteSchema>, { scope: "manual" }>,
  ipAddress: string | undefined,
) {
  try {
    return await db.$transaction(async (tx) => {
      const b = await tx.business.findUnique({
        where: { id: input.businessId },
        select: { id: true, latestTier: true, lead: { select: { id: true } } },
      });
      if (!b) throw new CrmError("Business not found", 404);
      if (b.lead)
        throw new CrmError("This business already has a lead", 409, { leadId: b.lead.id });
      if (b.latestTier === "disqualified")
        throw new CrmError("A disqualified business cannot become a lead", 409);
      if (input.assigneeId) await checkAssignee(tx, input.assigneeId);
      const t = now();
      const lead = await tx.lead.create({
        data: {
          businessId: b.id,
          source: "manual",
          priority: input.priority,
          assigneeId: input.assigneeId ?? null,
          createdById: actor.id,
          createdByLabel: actor.email,
          lastActivityAt: t,
          stageChangedAt: t,
          stageHistory: {
            create: {
              toStage: "new",
              byId: actor.id,
              byLabel: actor.email,
              at: t,
              note: "Created manually",
            },
          },
          activities: {
            create: [
              {
                type: "system",
                authorId: actor.id,
                authorLabel: actor.email,
                body: "Lead created manually.",
                metadata: { event: "created", source: "manual" },
                createdAt: t,
              },
              ...(input.note
                ? [
                    {
                      type: "note" as const,
                      authorId: actor.id,
                      authorLabel: actor.email,
                      body: input.note,
                      createdAt: t,
                    },
                  ]
                : []),
            ],
          },
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorLabel: actor.email,
          action: "crm.lead_create",
          entityType: "lead",
          entityId: lead.id,
          ipAddress,
          metadata: { businessId: b.id, source: "manual", assigneeId: input.assigneeId ?? null },
        },
      });
      return lead;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")
      throw new CrmError("This business already has a lead", 409);
    throw err;
  }
}

// ---------------- update / stage / assign ----------------

export const updateLeadSchema = z
  .object({
    version,
    priority: z.enum(LEAD_PRIORITIES).optional(),
    valueEstimatePaise: paise.nullable().optional(),
    nextFollowUpAt: isoDate.nullable().optional(),
    lawfulBasisNote: text(3, 500).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 1, "Nothing to change");

/** PATCH /api/crm/leads/[id]. Stage and assignee have their own endpoints (rules + audit). */
export async function updateLead(actor: Actor, leadId: string, raw: unknown) {
  need(actor, "crm:write", "edit leads");
  const input = updateLeadSchema.parse(raw);
  return db.$transaction(async (tx) => {
    const lead = await loadLead(tx, leadId);
    const data: Prisma.LeadUncheckedUpdateManyInput = {};
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (input.priority !== undefined && input.priority !== lead.priority) {
      data.priority = input.priority;
      changes.priority = { from: lead.priority, to: input.priority };
    }
    if (
      input.valueEstimatePaise !== undefined &&
      input.valueEstimatePaise !== lead.valueEstimatePaise
    ) {
      data.valueEstimatePaise = input.valueEstimatePaise;
      changes.valueEstimatePaise = { from: lead.valueEstimatePaise, to: input.valueEstimatePaise };
    }
    if (
      input.nextFollowUpAt !== undefined &&
      (input.nextFollowUpAt?.getTime() ?? null) !== (lead.nextFollowUpAt?.getTime() ?? null)
    ) {
      data.nextFollowUpAt = input.nextFollowUpAt;
      changes.nextFollowUpAt = { from: lead.nextFollowUpAt, to: input.nextFollowUpAt };
    }
    await bumpLead(tx, leadId, input.version, data);
    if (input.lawfulBasisNote !== undefined) {
      await tx.business.update({
        where: { id: lead.businessId },
        data: { lawfulBasisNote: input.lawfulBasisNote },
      });
      changes.lawfulBasisNote = { from: "(note)", to: input.lawfulBasisNote ? "(note)" : null };
    }
    if (Object.keys(changes).length)
      await tx.leadActivity.create({
        data: {
          leadId,
          type: "system",
          authorId: actor.id,
          authorLabel: actor.email,
          body: `Updated ${Object.keys(changes).join(", ")}.`,
          metadata: { event: "updated", changes } as Prisma.InputJsonValue,
        },
      });
    return tx.lead.findUniqueOrThrow({ where: { id: leadId } });
  });
}

export const stageChangeSchema = z.object({
  version,
  to: z.enum(LEAD_STAGES),
  note: text(1, 1000).optional(),
  lostReason: text(1, 500).optional(),
});

export async function changeStage(actor: Actor, leadId: string, raw: unknown) {
  need(actor, "crm:write", "change lead stages");
  const input = stageChangeSchema.parse(raw);
  const ipAddress = await clientIp();
  return db.$transaction(async (tx) => {
    const lead = await loadLead(tx, leadId);
    const check = checkStageTransition({
      from: lead.stage,
      to: input.to,
      contactStatus: lead.business.contactStatus,
      lostReason: input.lostReason,
      canReopen: can(actor.role, "crm:reopen"),
    });
    if (!check.ok) {
      if (lead.version !== input.version)
        throw new CrmError("This lead was changed by someone else. Reload and try again.", 409, {
          currentVersion: lead.version,
        });
      const status =
        check.code === "reopen_requires_admin" ? 403 : check.code === "do_not_contact" ? 409 : 400;
      throw new CrmError(check.message, status, { code: check.code });
    }
    const t = now();
    const to = input.to as LeadStage;
    await bumpLead(tx, leadId, input.version, {
      stage: to,
      stageChangedAt: t,
      lastActivityAt: t,
      lostReason: to === "lost" ? (input.lostReason ?? "").trim() : null,
      ...(to === "won" || to === "lost" ? { nextFollowUpAt: null } : {}),
    });
    await tx.leadStageHistory.create({
      data: {
        leadId,
        fromStage: lead.stage,
        toStage: to,
        byId: actor.id,
        byLabel: actor.email,
        at: t,
        note:
          [
            check.reopen ? "Reopened" : null,
            to === "lost" ? `Lost: ${input.lostReason?.trim()}` : null,
            input.note,
          ]
            .filter(Boolean)
            .join(". ") || null,
      },
    });
    await tx.leadActivity.create({
      data: {
        leadId,
        type: "stage_change",
        authorId: actor.id,
        authorLabel: actor.email,
        body: `Stage ${lead.stage.replace(/_/g, " ")} → ${to.replace(/_/g, " ")}${input.note ? `: ${input.note}` : ""}`,
        metadata: {
          from: lead.stage,
          to,
          reopen: check.reopen,
          lostReason: to === "lost" ? input.lostReason : null,
        },
        createdAt: t,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        actorLabel: actor.email,
        action: "crm.stage_change",
        entityType: "lead",
        entityId: leadId,
        ipAddress,
        metadata: {
          businessId: lead.businessId,
          from: lead.stage,
          to,
          reopen: check.reopen,
          ...(to === "lost" ? { lostReason: input.lostReason } : {}),
        },
      },
    });
    return tx.lead.findUniqueOrThrow({ where: { id: leadId } });
  });
}

export const assignSchema = z.object({ version, assigneeId: userId.nullable() });

export async function assignLead(actor: Actor, leadId: string, raw: unknown) {
  need(actor, "crm:write", "assign leads");
  const input = assignSchema.parse(raw);
  const ipAddress = await clientIp();
  return db.$transaction(async (tx) => {
    const lead = await loadLead(tx, leadId);
    const assignee = input.assigneeId ? await checkAssignee(tx, input.assigneeId) : null;
    if ((lead.assigneeId ?? null) === (input.assigneeId ?? null)) {
      if (lead.version !== input.version)
        throw new CrmError("This lead was changed by someone else. Reload and try again.", 409, {
          currentVersion: lead.version,
        });
      return lead;
    }
    await bumpLead(tx, leadId, input.version, { assigneeId: input.assigneeId });
    await tx.leadActivity.create({
      data: {
        leadId,
        type: "assignment",
        authorId: actor.id,
        authorLabel: actor.email,
        body: assignee ? `Assigned to ${assignee.email}.` : "Unassigned.",
        metadata: { from: lead.assigneeId, to: input.assigneeId },
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        actorLabel: actor.email,
        action: "crm.assign",
        entityType: "lead",
        entityId: leadId,
        ipAddress,
        metadata: { businessId: lead.businessId, from: lead.assigneeId, to: input.assigneeId },
      },
    });
    return tx.lead.findUniqueOrThrow({ where: { id: leadId } });
  });
}

// ---------------- activities ----------------

export const addActivitySchema = z.object({
  type: z.enum(MANUAL_ACTIVITY_TYPES),
  body: text(1, 5000),
  /** When a call/meeting happened (defaults to now); not in the future. */
  occurredAt: isoDate.optional(),
});

export async function addActivity(actor: Actor, leadId: string, raw: unknown) {
  need(actor, "crm:write", "add to the timeline");
  const input = addActivitySchema.parse(raw);
  return db.$transaction(async (tx) => {
    await loadLead(tx, leadId);
    const t = now();
    if (input.occurredAt && input.occurredAt.getTime() > t.getTime() + 60_000)
      throw new CrmError("occurredAt cannot be in the future");
    const a = await tx.leadActivity.create({
      data: {
        leadId,
        type: input.type,
        authorId: actor.id,
        authorLabel: actor.email,
        body: input.body,
        metadata: input.occurredAt ? { occurredAt: input.occurredAt.toISOString() } : Prisma.DbNull,
        createdAt: t,
      },
    });
    await tx.lead.update({ where: { id: leadId }, data: { lastActivityAt: t } });
    return a;
  });
}

export const editNoteSchema = z.object({ body: text(1, 5000) });

/** Notes only, by their author, within 15 minutes (the database trigger enforces it too). */
export async function editNote(actor: Actor, leadId: string, activityId: string, raw: unknown) {
  need(actor, "crm:write", "edit notes");
  const input = editNoteSchema.parse(raw);
  const a = await db.leadActivity.findFirst({ where: { id: activityId, leadId } });
  if (!a) throw new CrmError("Activity not found", 404);
  const ok = canEditActivity(a, actor.id, now());
  if (!ok.ok) throw new CrmError(ok.message, 403);
  try {
    return await db.leadActivity.update({
      where: { id: a.id },
      data: { body: input.body, editedAt: now() },
    });
  } catch (err) {
    if (err instanceof Error && /15 minutes/.test(err.message))
      throw new CrmError("Notes can be edited only within 15 minutes", 403);
    throw err;
  }
}

// ---------------- tasks ----------------

export const createTaskSchema = z.object({
  title: text(1, 200),
  dueAt: isoDate.nullable().optional(),
  assigneeId: userId.nullable().optional(),
});
export const updateTaskSchema = z
  .object({
    title: text(1, 200).optional(),
    dueAt: isoDate.nullable().optional(),
    assigneeId: userId.nullable().optional(),
    status: z.enum(["open", "done", "cancelled"]).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");

export async function createTask(actor: Actor, leadId: string, raw: unknown) {
  need(actor, "crm:write", "add tasks");
  const input = createTaskSchema.parse(raw);
  return db.$transaction(async (tx) => {
    await loadLead(tx, leadId);
    if (input.assigneeId) await checkAssignee(tx, input.assigneeId);
    return tx.leadTask.create({
      data: {
        leadId,
        title: input.title,
        dueAt: input.dueAt ?? null,
        assigneeId: input.assigneeId ?? actor.id,
        createdById: actor.id,
        createdByLabel: actor.email,
      },
    });
  });
}

export async function updateTask(actor: Actor, leadId: string, taskId: string, raw: unknown) {
  need(actor, "crm:write", "edit tasks");
  const input = updateTaskSchema.parse(raw);
  return db.$transaction(async (tx) => {
    const task = await tx.leadTask.findFirst({ where: { id: taskId, leadId } });
    if (!task) throw new CrmError("Task not found", 404);
    if (input.assigneeId) await checkAssignee(tx, input.assigneeId);
    const t = now();
    const data: Prisma.LeadTaskUncheckedUpdateInput = {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
      ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
    };
    const statusChange = input.status !== undefined && input.status !== task.status;
    if (statusChange) {
      data.status = input.status;
      if (input.status === "done") {
        data.completedAt = t;
        data.completedById = actor.id;
        data.completedByLabel = actor.email;
      } else {
        data.completedAt = null;
        data.completedById = null;
        data.completedByLabel = null;
      }
    }
    const updated = await tx.leadTask.update({ where: { id: task.id }, data });
    if (statusChange && input.status === "done") {
      await tx.leadActivity.create({
        data: {
          leadId,
          type: "task_done",
          authorId: actor.id,
          authorLabel: actor.email,
          body: `Task done: ${updated.title}`,
          metadata: { taskId: task.id },
          createdAt: t,
        },
      });
      await tx.lead.update({ where: { id: leadId }, data: { lastActivityAt: t } });
    }
    return updated;
  });
}

/** DELETE cancels (tasks are kept for the record). */
export async function cancelTask(actor: Actor, leadId: string, taskId: string) {
  return updateTask(actor, leadId, taskId, { status: "cancelled" });
}

// ---------------- contacts ----------------

const phoneField = z
  .string()
  .trim()
  .max(40)
  .transform((v, ctx) => {
    const n = normalizeLeadPhone(v);
    if (!n) {
      ctx.addIssue({ code: "custom", message: "Not a valid phone number" });
      return z.NEVER;
    }
    return n;
  });
const contactFields = {
  personName: text(1, 120).nullable().optional(),
  role: text(1, 80).nullable().optional(),
  phone: phoneField.nullable().optional(),
  email: z.email().max(254).toLowerCase().nullable().optional(),
  whatsapp: phoneField.nullable().optional(),
  isPrimary: z.boolean().optional(),
  sourceFactId: id.nullable().optional(),
};
export const createContactSchema = z
  .object(contactFields)
  .strict()
  .refine(
    (c) => c.personName || c.phone || c.email || c.whatsapp,
    "Give a name or at least one channel",
  );
export const updateContactSchema = z
  .object(contactFields)
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");

async function checkSourceFact(tx: Prisma.TransactionClient, factId: string, businessId: string) {
  const f = await tx.researchFact.findUnique({
    where: { id: factId },
    select: { businessId: true },
  });
  if (!f || f.businessId !== businessId)
    throw new CrmError("sourceFactId must be a research fact of this lead's business");
}

export async function createContact(actor: Actor, leadId: string, raw: unknown) {
  need(actor, "crm:write", "add contacts");
  const input = createContactSchema.parse(raw);
  return db.$transaction(async (tx) => {
    const lead = await loadLead(tx, leadId);
    if (input.sourceFactId) await checkSourceFact(tx, input.sourceFactId, lead.businessId);
    const hasPrimary = await tx.leadContact.count({ where: { leadId, isPrimary: true } });
    const isPrimary = input.isPrimary ?? hasPrimary === 0;
    if (isPrimary)
      await tx.leadContact.updateMany({ where: { leadId }, data: { isPrimary: false } });
    return tx.leadContact.create({
      data: {
        leadId,
        personName: input.personName ?? null,
        role: input.role ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        whatsapp: input.whatsapp ?? null,
        isPrimary,
        sourceFactId: input.sourceFactId ?? null,
      },
    });
  });
}

export async function updateContact(actor: Actor, leadId: string, contactId: string, raw: unknown) {
  need(actor, "crm:write", "edit contacts");
  const input = updateContactSchema.parse(raw);
  return db.$transaction(async (tx) => {
    const lead = await loadLead(tx, leadId);
    const c = await tx.leadContact.findFirst({ where: { id: contactId, leadId } });
    if (!c) throw new CrmError("Contact not found", 404);
    if (input.sourceFactId) await checkSourceFact(tx, input.sourceFactId, lead.businessId);
    const merged = { ...c, ...input };
    if (!merged.personName && !merged.phone && !merged.email && !merged.whatsapp)
      throw new CrmError("A contact needs a name or at least one channel");
    if (input.isPrimary === true)
      await tx.leadContact.updateMany({
        where: { leadId, NOT: { id: c.id } },
        data: { isPrimary: false },
      });
    return tx.leadContact.update({ where: { id: c.id }, data: input });
  });
}

export async function deleteContact(actor: Actor, leadId: string, contactId: string) {
  need(actor, "crm:write", "delete contacts");
  const r = await db.leadContact.deleteMany({ where: { id: contactId, leadId } });
  if (r.count === 0) throw new CrmError("Contact not found", 404);
  return { deleted: true };
}

// ---------------- tags ----------------

export const setTagsSchema = z.object({ tags: z.array(z.string()).max(20) });

/** Replaces the lead's tags. Tags are created on first use, unique case-insensitively. */
export async function setTags(actor: Actor, leadId: string, raw: unknown) {
  need(actor, "crm:write", "tag leads");
  const input = setTagsSchema.parse(raw);
  const names = normalizeTagList(input.tags);
  return db.$transaction(async (tx) => {
    await loadLead(tx, leadId);
    const tagIds: string[] = [];
    for (const name of names) {
      const t = await tx.leadTag.upsert({
        where: { key: tagKey(name) },
        create: { name, key: tagKey(name) },
        update: {},
      });
      tagIds.push(t.id);
    }
    await tx.leadTagLink.deleteMany({ where: { leadId, tagId: { notIn: tagIds } } });
    await tx.leadTagLink.createMany({
      data: tagIds.map((tagId) => ({ leadId, tagId })),
      skipDuplicates: true,
    });
    const tags = await tx.leadTagLink.findMany({
      where: { leadId },
      select: { tag: { select: { id: true, name: true } } },
    });
    return tags.map((t) => t.tag);
  });
}

export async function listTags(actor: Actor) {
  need(actor, "crm:read", "read tags");
  const tags = await db.leadTag.findMany({
    orderBy: { key: "asc" },
    select: { id: true, name: true, _count: { select: { leads: true } } },
  });
  return tags.map((t) => ({ id: t.id, name: t.name, leadCount: t._count.leads }));
}

/** Active users who can be assigned leads and tasks. */
export async function listAssignees(actor: Actor) {
  need(actor, "crm:read", "read leads");
  const users = await db.user.findMany({
    where: { role: { in: ["operator", "admin", "owner"] }, NOT: { banned: true } },
    select: { id: true, name: true, email: true, role: true },
    orderBy: { email: "asc" },
  });
  return users;
}

// ---------------- consent / do-not-contact ----------------

export const setDncSchema = z.object({
  status: z.enum(CONTACT_STATUSES.filter((s) => s !== "ok") as ["do_not_contact", "opted_out"]),
  reason: text(3, 500),
  lawfulBasisNote: text(3, 500).optional(),
});
export const clearDncSchema = z.object({ reason: text(3, 500) });

/**
 * Marks the lead's business do-not-contact / opted-out (operator+). Recorded on the business so it
 * also blocks future outreach to it outside the CRM; the lead cannot enter outreach stages.
 */
export async function setContactStatus(actor: Actor, leadId: string, raw: unknown) {
  need(actor, "crm:write", "mark do-not-contact");
  const input = setDncSchema.parse(raw);
  const ipAddress = await clientIp();
  return db.$transaction(async (tx) => {
    const lead = await loadLead(tx, leadId);
    const from: ContactStatus = lead.business.contactStatus;
    const t = now();
    const b = await tx.business.update({
      where: { id: lead.businessId },
      data: {
        contactStatus: input.status,
        contactStatusReason: input.reason,
        contactStatusById: actor.id,
        contactStatusByLabel: actor.email,
        contactStatusAt: t,
        ...(input.lawfulBasisNote ? { lawfulBasisNote: input.lawfulBasisNote } : {}),
      },
      select: { id: true, contactStatus: true, contactStatusReason: true, contactStatusAt: true },
    });
    await tx.leadActivity.create({
      data: {
        leadId,
        type: "system",
        authorId: actor.id,
        authorLabel: actor.email,
        body: `Marked ${input.status.replace(/_/g, " ")}: ${input.reason}`,
        metadata: { event: "dnc_set", from, to: input.status },
        createdAt: t,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        actorLabel: actor.email,
        action: "crm.dnc_set",
        entityType: "business",
        entityId: lead.businessId,
        ipAddress,
        metadata: { leadId, from, to: input.status, reason: input.reason },
      },
    });
    return b;
  });
}

/** Clears do-not-contact / opted-out (admin+ only, reason required). */
export async function clearContactStatus(actor: Actor, leadId: string, raw: unknown) {
  need(actor, "crm:dnc_clear", "clear do-not-contact");
  const input = clearDncSchema.parse(raw);
  const ipAddress = await clientIp();
  return db.$transaction(async (tx) => {
    const lead = await loadLead(tx, leadId);
    const from = lead.business.contactStatus;
    if (from === "ok") throw new CrmError("This business is not marked do-not-contact", 409);
    const t = now();
    const b = await tx.business.update({
      where: { id: lead.businessId },
      data: {
        contactStatus: "ok",
        contactStatusReason: input.reason,
        contactStatusById: actor.id,
        contactStatusByLabel: actor.email,
        contactStatusAt: t,
      },
      select: { id: true, contactStatus: true, contactStatusReason: true, contactStatusAt: true },
    });
    await tx.leadActivity.create({
      data: {
        leadId,
        type: "system",
        authorId: actor.id,
        authorLabel: actor.email,
        body: `Do-not-contact cleared: ${input.reason}`,
        metadata: { event: "dnc_clear", from, to: "ok" },
        createdAt: t,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        actorLabel: actor.email,
        action: "crm.dnc_clear",
        entityType: "business",
        entityId: lead.businessId,
        ipAddress,
        metadata: { leadId, from, reason: input.reason },
      },
    });
    return b;
  });
}

// ---------------- CSV import ----------------

export const IMPORT_PROVIDER = "csv-import";

/**
 * Imports leads from CSV (admin+). Each valid row links to an existing business (dedupe by
 * normalised phone or name + PIN code) or creates one (provider csv-import; needs lat/lon because
 * business coordinates are required and Kalpix never bulk-geocodes). A business that already has
 * a lead is skipped. dryRun validates and reports without writing.
 */
export async function importLeads(actor: Actor, csv: string, opts: { dryRun?: boolean } = {}) {
  need(actor, "crm:import", "import leads");
  if (csv.length > 2_000_000) throw new CrmError("CSV is larger than 2 MB", 413);
  const parsed = parseLeadImport(csv);
  const errors = [...parsed.errors];
  const phones = parsed.rows.map((r) => r.row.phone).filter((p): p is string => Boolean(p));
  const pins = parsed.rows.map((r) => r.row.postcode).filter((p): p is string => Boolean(p));
  const phoneVariants = phones.flatMap((p) => [
    p,
    p.replace(/^\+91/, ""),
    `0${p.replace(/^\+91/, "")}`,
  ]);
  const existing = parsed.rows.length
    ? await db.business.findMany({
        where: {
          OR: [
            ...(phoneVariants.length ? [{ phone: { in: phoneVariants } }] : []),
            ...(pins.length ? [{ postcode: { in: pins } }] : []),
          ],
        },
        select: {
          id: true,
          name: true,
          phone: true,
          postcode: true,
          latestTier: true,
          lead: { select: { id: true } },
        },
      })
    : [];
  type Plan =
    | {
        line: number;
        kind: "link";
        businessId: string;
        by: string;
        row: (typeof parsed.rows)[number]["row"];
      }
    | { line: number; kind: "create"; row: (typeof parsed.rows)[number]["row"] };
  const plans: Plan[] = [];
  const skipped: { line: number; reason: string; businessId?: string }[] = [];
  for (const { line, row } of parsed.rows) {
    const hit = findExistingBusiness(row, existing);
    if (hit) {
      if (hit.business.lead)
        skipped.push({ line, reason: "already a lead", businessId: hit.business.id });
      else if (hit.business.latestTier === "disqualified")
        skipped.push({ line, reason: "business is disqualified", businessId: hit.business.id });
      else plans.push({ line, kind: "link", businessId: hit.business.id, by: hit.by, row });
    } else if (row.lat === undefined || row.lon === undefined) {
      errors.push({
        line,
        message: "New business: lat and lon are required (no matching business found)",
      });
    } else plans.push({ line, kind: "create", row });
  }
  const summary = {
    dryRun: Boolean(opts.dryRun),
    rows: parsed.rows.length + parsed.errors.length,
    valid: plans.length,
    willCreateBusinesses: plans.filter((p) => p.kind === "create").length,
    willLinkBusinesses: plans.filter((p) => p.kind === "link").length,
    skipped,
    errors: errors.sort((a, b) => a.line - b.line),
  };
  if (opts.dryRun)
    return { ...summary, created: [] as { line: number; leadId: string; businessId: string }[] };

  const ipAddress = await clientIp();
  const created: { line: number; leadId: string; businessId: string }[] = [];
  const t = now();
  for (const p of plans) {
    try {
      const out = await db.$transaction(async (tx) => {
        let businessId: string;
        if (p.kind === "link") businessId = p.businessId;
        else {
          const r = p.row;
          const b = await tx.business.create({
            data: {
              name: r.name,
              normalizedName: normalizeName(r.name),
              category: r.category,
              provider: IMPORT_PROVIDER,
              providerId: `${t.toISOString()}/${p.line}/${crypto.randomUUID()}`,
              addressFull: r.address ?? null,
              city: r.city ?? null,
              state: r.state ?? null,
              postcode: r.postcode ?? null,
              country: "India",
              lat: r.lat!,
              lon: r.lon!,
              phone: r.phone ?? null,
              email: r.email ?? null,
              website: r.website ?? null,
              hasWebsite: Boolean(r.website),
              source: "import",
              sourceType: "manual_import",
              sourceUrl: `import:csv/${actor.email}`,
              collectedAt: t,
              lastSeenAt: t,
              confidence: 0,
              usageRestrictions: "Imported by a team member; provenance is the uploader's file",
              lawfulBasisNote: r.lawful_basis_note ?? null,
            },
          });
          businessId = b.id;
        }
        const r = p.row;
        const lead = await tx.lead.create({
          data: {
            businessId,
            source: "import",
            priority: r.priority ?? "normal",
            valueEstimatePaise: r.value_estimate_paise ?? null,
            createdById: actor.id,
            createdByLabel: actor.email,
            lastActivityAt: t,
            stageChangedAt: t,
            stageHistory: {
              create: {
                toStage: "new",
                byId: actor.id,
                byLabel: actor.email,
                at: t,
                note: `Imported (line ${p.line})`,
              },
            },
            activities: {
              create: [
                {
                  type: "system",
                  authorId: actor.id,
                  authorLabel: actor.email,
                  body:
                    p.kind === "link"
                      ? `Lead imported from CSV line ${p.line}; matched an existing business by ${p.by.replace("_", " + ")}.`
                      : `Lead imported from CSV line ${p.line}; business created from the file.`,
                  metadata: {
                    event: "imported",
                    line: p.line,
                    match: p.kind === "link" ? p.by : null,
                  },
                  createdAt: t,
                },
                ...(r.note
                  ? [
                      {
                        type: "note" as const,
                        authorId: actor.id,
                        authorLabel: actor.email,
                        body: r.note,
                        createdAt: t,
                      },
                    ]
                  : []),
              ],
            },
            ...(r.contact_name || r.phone || r.email || r.whatsapp
              ? {
                  contacts: {
                    create: {
                      personName: r.contact_name ?? null,
                      role: r.contact_role ?? null,
                      phone: r.phone ?? null,
                      email: r.email ?? null,
                      whatsapp: r.whatsapp ?? null,
                      isPrimary: true,
                    },
                  },
                }
              : {}),
          },
        });
        for (const name of r.tags) {
          const tag = await tx.leadTag.upsert({
            where: { key: tagKey(name) },
            create: { name, key: tagKey(name) },
            update: {},
          });
          await tx.leadTagLink.create({ data: { leadId: lead.id, tagId: tag.id } });
        }
        return { leadId: lead.id, businessId };
      });
      created.push({ line: p.line, ...out });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")
        skipped.push({ line: p.line, reason: "already a lead" });
      else throw err;
    }
  }
  await db.auditLog.create({
    data: {
      actorId: actor.id,
      actorLabel: actor.email,
      action: "crm.lead_import",
      entityType: "lead",
      ipAddress,
      metadata: {
        rows: summary.rows,
        created: created.length,
        businessesCreated: plans.filter((p) => p.kind === "create").length,
        linked: plans.filter((p) => p.kind === "link").length,
        skipped: skipped.length,
        errors: errors.length,
      },
    },
  });
  return { ...summary, created };
}

// ---------------- CSV export ----------------

const EXPORT_HEADERS = [
  "lead_id",
  "business_id",
  "business_name",
  "category",
  "city",
  "postcode",
  "phone",
  "email",
  "contact_status",
  "stage",
  "priority",
  "source",
  "assignee_email",
  "value_estimate_paise",
  "currency",
  "next_follow_up_at",
  "overdue",
  "health",
  "tier",
  "score",
  "tags",
  "lost_reason",
  "created_at",
  "stage_changed_at",
  "last_activity_at",
];

/**
 * CSV of the filtered lead list (admin+), max 50,000 rows, formula-injection safe (toCsv). Phone and
 * email are left blank for do-not-contact / opted-out businesses so an export cannot feed outreach.
 */
export async function exportLeads(actor: Actor, filter: LeadListFilter) {
  need(actor, "crm:export", "export leads");
  const t = now();
  const { staleDays } = crmSettings();
  const { page: _page, ...f } = filter;
  void _page;
  const rows = await db.lead.findMany({
    where: leadWhere(f, { actorId: actor.id, now: t, staleDays }),
    orderBy: LEAD_LIST_ORDER,
    take: CRM_EXPORT_MAX_ROWS,
    include: {
      business: {
        select: {
          id: true,
          name: true,
          category: true,
          city: true,
          postcode: true,
          phone: true,
          email: true,
          contactStatus: true,
          latestTier: true,
          latestScore: true,
        },
      },
      assignee: { select: { email: true } },
      tags: { select: { tag: { select: { name: true } } } },
      tasks: { where: { status: "open", dueAt: { lt: t } }, select: { id: true }, take: 1 },
    },
  });
  const csv = toCsv(
    EXPORT_HEADERS,
    rows.map((l) => {
      const ok = l.business.contactStatus === "ok";
      return [
        l.id,
        l.business.id,
        l.business.name,
        l.business.category,
        l.business.city,
        l.business.postcode,
        ok ? l.business.phone : "",
        ok ? l.business.email : "",
        l.business.contactStatus,
        l.stage,
        l.priority,
        l.source,
        l.assignee?.email,
        l.valueEstimatePaise,
        l.currency,
        l.nextFollowUpAt,
        isFollowUpOverdue(l, t) || l.tasks.length > 0,
        leadHealth(l, t, staleDays).health,
        l.business.latestTier,
        l.business.latestScore,
        l.tags.map((x) => x.tag.name).join("; "),
        l.lostReason,
        l.createdAt,
        l.stageChangedAt,
        l.lastActivityAt,
      ];
    }),
  );
  await db.auditLog.create({
    data: {
      actorId: actor.id,
      actorLabel: actor.email,
      action: "crm.export",
      entityType: "lead",
      ipAddress: await clientIp(),
      metadata: { filters: f, rows: rows.length, truncated: rows.length === CRM_EXPORT_MAX_ROWS },
    },
  });
  return { csv, rows: rows.length };
}
