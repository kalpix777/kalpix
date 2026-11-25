// Phase 5: writing verification results and manual overrides to research_fact.
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  MANUAL_OVERRIDE_STATUSES,
  type FactVerification,
  type VerificationStatus,
} from "@kalpix/core";

/**
 * Applies the automatic pass to facts that have no manual override. Rows whose status, method and
 * evidence are unchanged still get verifiedAt refreshed (it is "last assessed"). Returns how many
 * facts are verified / invalid after the pass.
 */
export async function applyFactVerifications(
  tx: Prisma.TransactionClient,
  results: FactVerification[],
  now = new Date(),
) {
  for (const r of results)
    await tx.researchFact.updateMany({
      where: { id: r.factId, verificationOverride: false },
      data: {
        verificationStatus: r.status,
        verificationMethod: r.method,
        verificationEvidence: r.evidence as Prisma.InputJsonValue,
        verifiedAt: now,
      },
    });
  return {
    verified: results.filter((r) => r.status === "verified").length,
    invalid: results.filter((r) => r.status === "invalid").length,
  };
}

export interface OverrideInput {
  factId: string;
  status: VerificationStatus;
  reason: string;
  actorId?: string | null;
  actorLabel: string;
}

/**
 * A person sets a fact's verification status (backend only; the caller enforces RBAC). Stores who,
 * when and why on the fact, keeps the previous automatic result in the evidence, and writes an
 * audit_log entry in the same transaction. The automatic pass never changes an overridden fact.
 */
export async function overrideFactVerification(db: PrismaClient, input: OverrideInput) {
  if (!MANUAL_OVERRIDE_STATUSES.includes(input.status))
    throw new Error(`status must be one of ${MANUAL_OVERRIDE_STATUSES.join(", ")}`);
  const reason = input.reason?.trim();
  if (!reason) throw new Error("A reason is required for a manual verification override");
  if (reason.length > 500) throw new Error("Reason must be at most 500 characters");
  const actorLabel = input.actorLabel?.trim();
  if (!actorLabel) throw new Error("actorLabel is required");
  return db.$transaction(async (tx) => {
    const fact = await tx.researchFact.findUnique({ where: { id: input.factId } });
    if (!fact) throw new Error("Fact not found");
    const now = new Date();
    const updated = await tx.researchFact.update({
      where: { id: fact.id },
      data: {
        verificationStatus: input.status,
        verificationMethod: "manual",
        verificationEvidence: {
          previous: {
            status: fact.verificationStatus,
            method: fact.verificationMethod,
            evidence: fact.verificationEvidence ?? null,
            override: fact.verificationOverride,
          },
        } as Prisma.InputJsonValue,
        verificationOverride: true,
        verifiedAt: now,
        verifiedById: input.actorId ?? null,
        verifiedByLabel: actorLabel,
        overrideReason: reason,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        actorLabel,
        action: "verification.override",
        entityType: "research_fact",
        entityId: fact.id,
        metadata: {
          businessId: fact.businessId,
          field: fact.field,
          from: fact.verificationStatus,
          to: input.status,
          reason,
        },
      },
    });
    return updated;
  });
}

/** Removes a manual override; the fact returns to "unverified" until the next automatic pass. */
export async function clearFactOverride(
  db: PrismaClient,
  input: { factId: string; actorId?: string | null; actorLabel: string; reason?: string },
) {
  const actorLabel = input.actorLabel?.trim();
  if (!actorLabel) throw new Error("actorLabel is required");
  return db.$transaction(async (tx) => {
    const fact = await tx.researchFact.findUnique({ where: { id: input.factId } });
    if (!fact) throw new Error("Fact not found");
    if (!fact.verificationOverride) return fact;
    const updated = await tx.researchFact.update({
      where: { id: fact.id },
      data: {
        verificationStatus: "unverified",
        verificationMethod: null,
        verificationEvidence: Prisma.DbNull,
        verificationOverride: false,
        verifiedAt: null,
        verifiedById: null,
        verifiedByLabel: null,
        overrideReason: null,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        actorLabel,
        action: "verification.override_clear",
        entityType: "research_fact",
        entityId: fact.id,
        metadata: {
          businessId: fact.businessId,
          field: fact.field,
          from: fact.verificationStatus,
          reason: input.reason?.trim().slice(0, 500) ?? null,
        },
      },
    });
    return updated;
  });
}
