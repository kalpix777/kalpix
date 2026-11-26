// Phase 6: promotion of qualified businesses to CRM leads. Shared by the admin API
// (POST /api/crm/leads, via the "@kalpix/worker/crm-promote" export) and usable from worker jobs.
// Idempotent: lead.businessId is unique, so a business never gets a second lead, also under a race.
// Never promotes disqualified businesses or businesses marked do-not-contact / opted-out.
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  CRM_MAX_PROMOTE,
  crmSettingsFromEnv,
  planPromotion,
  primaryContactFromFacts,
  PROMOTABLE_TIERS,
  roundRobinAssignees,
  type ContactStatus,
  type PromotableTier,
  type PromotionSkip,
} from "@kalpix/core";

export const CRM_ROUND_ROBIN_SETTING_KEY = "crm.round_robin";

export type PromoteScope =
  | { type: "qualification_run"; runId: string }
  | { type: "businesses"; businessIds: string[] }
  | { type: "all" };

export interface PromoteLeadsInput {
  scope: PromoteScope;
  /** Defaults to CRM_PROMOTE_TIERS (default hot,warm). "disqualified" is refused. */
  tiers?: PromotableTier[];
  /** round_robin: assign across active operators (role operator, not suspended). */
  assign?: "none" | "round_robin";
  /** Max leads created by this call (1-1000, default 1000). */
  limit?: number;
  actor: { id?: string | null; label: string };
  ipAddress?: string;
}

export interface PromoteLeadsResult {
  considered: number;
  created: { leadId: string; businessId: string; assigneeId: string | null }[];
  skipped: Record<PromotionSkip, number>;
  tiers: PromotableTier[];
}

export class PromoteError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Active operators eligible for round-robin, sorted by id. */
export async function activeOperatorIds(db: PrismaClient | Prisma.TransactionClient) {
  const users = await db.user.findMany({
    where: { role: "operator", NOT: { banned: true } },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return users.map((u) => u.id);
}

export async function promoteQualifiedLeads(
  db: PrismaClient,
  input: PromoteLeadsInput,
  env: Record<string, string | undefined> = process.env,
): Promise<PromoteLeadsResult> {
  const tiers = input.tiers?.length
    ? [...new Set(input.tiers)]
    : crmSettingsFromEnv(env).promoteTiers;
  for (const t of tiers)
    if (!(PROMOTABLE_TIERS as readonly string[]).includes(t))
      throw new PromoteError(`Tier "${t}" cannot be promoted (disqualified never is)`);
  const limit = Math.min(Math.max(1, input.limit ?? CRM_MAX_PROMOTE), CRM_MAX_PROMOTE);
  const select = {
    id: true,
    latestTier: true,
    contactStatus: true,
    lead: { select: { id: true } },
  } as const;

  let rows: {
    id: string;
    latestTier: string | null;
    contactStatus: ContactStatus;
    lead: { id: string } | null;
  }[];
  if (input.scope.type === "qualification_run") {
    const run = await db.qualificationRun.findUnique({
      where: { id: input.scope.runId },
      select: { id: true },
    });
    if (!run) throw new PromoteError("Qualification run not found", 404);
    const ids = await db.businessQualification.findMany({
      where: { runId: run.id },
      select: { businessId: true },
    });
    rows = await db.business.findMany({
      where: { id: { in: ids.map((r) => r.businessId) } },
      select,
      orderBy: [{ latestScore: { sort: "desc", nulls: "last" } }, { id: "asc" }],
    });
  } else if (input.scope.type === "businesses") {
    const ids = [...new Set(input.scope.businessIds)];
    if (!ids.length) throw new PromoteError("Choose at least one business");
    if (ids.length > CRM_MAX_PROMOTE)
      throw new PromoteError(`At most ${CRM_MAX_PROMOTE} businesses per promotion`);
    rows = await db.business.findMany({
      where: { id: { in: ids } },
      select,
      orderBy: [{ latestScore: { sort: "desc", nulls: "last" } }, { id: "asc" }],
    });
    if (rows.length !== ids.length) throw new PromoteError("Business not found", 404);
  } else {
    rows = await db.business.findMany({
      where: { latestTier: { in: tiers }, lead: null, contactStatus: "ok" },
      select,
      orderBy: [{ latestScore: { sort: "desc", nulls: "last" } }, { id: "asc" }],
      take: limit,
    });
  }

  const plan = planPromotion(
    rows.map((r) => ({
      businessId: r.id,
      tier: r.latestTier,
      contactStatus: r.contactStatus,
      hasLead: r.lead !== null,
    })),
    tiers,
  );
  const skipped: Record<PromotionSkip, number> = {
    has_lead: 0,
    tier_not_selected: 0,
    disqualified: 0,
    do_not_contact: 0,
  };
  for (const s of plan.skipped) skipped[s.reason]++;
  const toPromote = plan.promote.slice(0, limit);

  let assignees: (string | null)[] = toPromote.map(() => null);
  if (input.assign === "round_robin" && toPromote.length) {
    const cursor = await db.systemSetting.findUnique({
      where: { key: CRM_ROUND_ROBIN_SETTING_KEY },
    });
    const last =
      cursor && typeof cursor.value === "object" && cursor.value && "lastUserId" in cursor.value
        ? String((cursor.value as { lastUserId?: unknown }).lastUserId ?? "")
        : null;
    assignees = roundRobinAssignees(await activeOperatorIds(db), last || null, toPromote.length);
  }

  const created: PromoteLeadsResult["created"] = [];
  const actorId = input.actor.id ?? null;
  const now = new Date();
  for (const [i, c] of toPromote.entries()) {
    const assigneeId = assignees[i] ?? null;
    try {
      const lead = await db.$transaction(async (tx) => {
        const qual = await tx.businessQualification.findFirst({
          where: { businessId: c.businessId },
          orderBy: { qualifiedAt: "desc" },
          select: { id: true, tier: true, score: true },
        });
        const facts = await tx.researchFact.findMany({
          where: {
            businessId: c.businessId,
            field: { in: ["phone", "email", "whatsapp"] },
            verificationStatus: { not: "invalid" },
          },
          select: {
            id: true,
            field: true,
            value: true,
            verificationStatus: true,
            confidence: true,
          },
        });
        const contact = primaryContactFromFacts(facts);
        const tier = c.tier as PromotableTier;
        return tx.lead.create({
          data: {
            businessId: c.businessId,
            stage: "new",
            source: "qualification",
            assigneeId,
            qualificationId: qual?.id ?? null,
            promotedTier: tier,
            createdById: actorId,
            createdByLabel: input.actor.label,
            lastActivityAt: now,
            stageChangedAt: now,
            stageHistory: {
              create: {
                fromStage: null,
                toStage: "new",
                byId: actorId,
                byLabel: input.actor.label,
                at: now,
                note: `Promoted from qualification (${tier}${qual ? `, score ${qual.score}` : ""})`,
              },
            },
            activities: {
              create: [
                {
                  type: "system",
                  authorId: actorId,
                  authorLabel: input.actor.label,
                  body: `Lead created from qualification: tier ${tier}${qual ? `, score ${qual.score}` : ""}.`,
                  metadata: { event: "promoted", tier, qualificationId: qual?.id ?? null },
                  createdAt: now,
                },
                ...(assigneeId
                  ? [
                      {
                        type: "assignment" as const,
                        authorId: actorId,
                        authorLabel: input.actor.label,
                        body: "Assigned by round-robin at promotion.",
                        metadata: { from: null, to: assigneeId, mode: "round_robin" },
                        createdAt: now,
                      },
                    ]
                  : []),
              ],
            },
            ...(contact
              ? {
                  contacts: {
                    create: {
                      phone: contact.phone,
                      email: contact.email,
                      whatsapp: contact.whatsapp,
                      isPrimary: true,
                      sourceFactId: contact.sourceFactId,
                    },
                  },
                }
              : {}),
          },
          select: { id: true },
        });
      });
      created.push({ leadId: lead.id, businessId: c.businessId, assigneeId });
    } catch (err) {
      // Another request promoted the same business first: idempotent skip.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        skipped.has_lead++;
        continue;
      }
      throw err;
    }
  }

  const lastAssigned = [...created].reverse().find((c) => c.assigneeId)?.assigneeId;
  if (lastAssigned)
    await db.systemSetting.upsert({
      where: { key: CRM_ROUND_ROBIN_SETTING_KEY },
      create: {
        key: CRM_ROUND_ROBIN_SETTING_KEY,
        value: { lastUserId: lastAssigned },
        updatedBy: input.actor.label,
      },
      update: { value: { lastUserId: lastAssigned }, updatedBy: input.actor.label },
    });

  await db.auditLog.create({
    data: {
      actorId,
      actorLabel: input.actor.label,
      action: "crm.lead_promote",
      entityType: "lead",
      ipAddress: input.ipAddress,
      metadata: {
        scope:
          input.scope.type === "qualification_run"
            ? { type: "qualification_run", runId: input.scope.runId }
            : input.scope.type === "businesses"
              ? { type: "businesses", count: input.scope.businessIds.length }
              : { type: "all" },
        tiers,
        assign: input.assign ?? "none",
        considered: rows.length,
        created: created.length,
        skipped,
        leadIds: created.slice(0, 200).map((c) => c.leadId),
      },
    },
  });
  return { considered: rows.length, created, skipped, tiers };
}
