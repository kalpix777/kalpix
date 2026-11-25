import "server-only";
import { headers } from "next/headers";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  canEnable,
  KALPIX_CATEGORIES,
  MANUAL_OVERRIDE_STATUSES,
  QUALIFICATION_MAX_BUSINESSES_PER_RUN,
  QUALIFICATION_RULES_VERSION,
  QUALIFICATION_TIERS,
} from "@kalpix/core";
import {
  GEMINI_FREE_TIER_NOTICE,
  MODEL_PROVIDER_IDS,
  OLLAMA_NOTICE,
  promptVersion,
  resolveQualificationAiKind,
} from "@kalpix/providers";
import { db } from "@/lib/db";
import { can } from "@/lib/rbac";
import type { AiKind } from "@/lib/qualification-display";
import { recordAudit } from "./audit";

const uuid = z.string().regex(/^[0-9a-f-]{36}$/i, "Must be an id");
const common = {
  /** none = rules only; omitted means the configured default (QUALIFICATION_AI_PROVIDER). */
  ai: z.enum(["none", "mock", "ollama", "gemini"]).optional(),
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9-]{8,64}$/)
    .optional(),
};

export const qualificationFilterSchema = z
  .object({
    category: z.enum(KALPIX_CATEGORIES).optional(),
    city: z.string().trim().min(1).max(100).optional(),
    hasWebsite: z.boolean().optional(),
    tier: z.enum(QUALIFICATION_TIERS).optional(),
    staleAfterDays: z.number().int().min(1).max(3650).optional(),
    limit: z.number().int().min(1).max(QUALIFICATION_MAX_BUSINESSES_PER_RUN).default(200),
  })
  .strict();

export const startQualificationSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("discovery_run"), discoveryRunId: uuid, ...common }),
  z.object({ scope: z.literal("research_run"), researchRunId: uuid, ...common }),
  z.object({ scope: z.literal("filter"), filter: qualificationFilterSchema, ...common }),
  z.object({
    scope: z.literal("businesses"),
    businessIds: z
      .array(uuid)
      .min(1, "Choose at least one business")
      .max(QUALIFICATION_MAX_BUSINESSES_PER_RUN),
    ...common,
  }),
]);
export type StartQualificationInput = z.infer<typeof startQualificationSchema>;

export const overrideFactSchema = z.object({
  factId: uuid,
  status: z.enum(MANUAL_OVERRIDE_STATUSES as unknown as [string, ...string[]]),
  reason: z
    .string()
    .trim()
    .min(3, "Give a reason (at least 3 characters)")
    .max(500, "Reason must be at most 500 characters"),
});
export const clearOverrideSchema = z.object({
  factId: uuid,
  reason: z.string().trim().max(500).optional(),
});

interface Actor {
  id: string;
  email: string;
  role?: string | null;
}

export class QualificationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

// ---------------- AI readiness ----------------

export interface AiProviderStatus {
  kind: AiKind;
  providerId: string;
  name: string;
  /** null = not applicable (MOCK needs no owner approval outside production). */
  ownerEnabled: boolean | null;
  termsConfirmed: boolean | null;
  /** Name of the secret/config value required; its value is never read out. */
  keyName: string | null;
  keyPresent: boolean | null;
  ready: boolean;
  problems: string[];
  notice: string | null;
}

export interface AiReadiness {
  /** QUALIFICATION_AI_PROVIDER; "none" by default. */
  defaultKind: "none" | AiKind;
  defaultError: string | null;
  providers: AiProviderStatus[];
  promptVersion: string;
  rulesVersion: string;
}

const present = (k: string) => Boolean((process.env[k] ?? "").trim());

export async function aiReadiness(): Promise<AiReadiness> {
  let defaultKind: AiReadiness["defaultKind"] = "none";
  let defaultError: string | null = null;
  try {
    defaultKind = resolveQualificationAiKind(process.env);
  } catch (err) {
    defaultError = (err as Error).message;
  }
  const production = process.env.APP_ENV === "production";
  const rows = await db.providerConfig.findMany({
    where: { id: { in: [MODEL_PROVIDER_IDS.ollama, MODEL_PROVIDER_IDS.gemini] } },
  });
  const row = (id: string) => rows.find((r) => r.id === id);

  const mock: AiProviderStatus = {
    kind: "mock",
    providerId: MODEL_PROVIDER_IDS.mock,
    name: "MOCK model",
    ownerEnabled: null,
    termsConfirmed: null,
    keyName: null,
    keyPresent: null,
    ready: !production,
    problems: production ? ["The MOCK model is refused in production."] : [],
    notice: "Fixture output for tests: every AI text starts with MOCK. Never a real judgement.",
  };

  const modelStatus = (
    kind: "ollama" | "gemini",
    keyName: string,
    notice: string,
  ): AiProviderStatus => {
    const id = MODEL_PROVIDER_IDS[kind];
    const cfg = row(id);
    const keyPresent = present(keyName);
    const problems: string[] = [];
    if (!cfg) problems.push(`${id} is not in the provider catalogue (run pnpm db:seed).`);
    else {
      if (!cfg.commercialUseVerified)
        problems.push("The owner has not confirmed its commercial terms (AI Provider Settings).");
      if (!cfg.enabled) problems.push("Not enabled by the owner (AI Provider Settings).");
      const gate = canEnable(
        {
          id: cfg.id,
          name: cfg.name,
          category: cfg.category,
          costTier: cfg.costTier,
          requiredSecrets: cfg.requiredSecrets,
          commercialUseVerified: cfg.commercialUseVerified,
        },
        new Set(cfg.requiredSecrets.filter(present)),
      );
      if (!gate.ok && keyPresent && cfg.commercialUseVerified) problems.push(gate.error);
    }
    if (!keyPresent) problems.push(`${keyName} is not set on the server.`);
    return {
      kind,
      providerId: id,
      name: cfg?.name ?? id,
      ownerEnabled: Boolean(cfg?.enabled),
      termsConfirmed: Boolean(cfg?.commercialUseVerified),
      keyName,
      keyPresent,
      ready: problems.length === 0,
      problems,
      notice,
    };
  };

  return {
    defaultKind,
    defaultError,
    providers: [
      mock,
      modelStatus("ollama", "OLLAMA_BASE_URL", OLLAMA_NOTICE),
      modelStatus("gemini", "GEMINI_API_KEY", GEMINI_FREE_TIER_NOTICE),
    ],
    promptVersion: promptVersion(process.env),
    rulesVersion: QUALIFICATION_RULES_VERSION,
  };
}

// ---------------- enqueue ----------------

function scopeData(input: StartQualificationInput) {
  const base = {
    businessIds: [] as string[],
    discoveryRunId: null as string | null,
    researchRunId: null as string | null,
    filter: null as Record<string, string | number | boolean> | null,
  };
  if (input.scope === "businesses")
    return { ...base, scopeType: "businesses", businessIds: [...new Set(input.businessIds)] };
  if (input.scope === "discovery_run")
    return { ...base, scopeType: "discovery_run", discoveryRunId: input.discoveryRunId };
  if (input.scope === "research_run")
    return { ...base, scopeType: "research_run", researchRunId: input.researchRunId };
  const filter = Object.fromEntries(
    Object.entries(input.filter).filter(([, v]) => v !== undefined),
  ) as Record<string, string | number | boolean>;
  return { ...base, scopeType: "filter", filter };
}

function sortKeys(v: unknown): unknown {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v ?? null;
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y)),
  );
}

const sameScope = (
  a: {
    scopeType: string;
    businessIds: string[];
    discoveryRunId: string | null;
    researchRunId: string | null;
    filter: unknown;
  },
  b: ReturnType<typeof scopeData>,
) =>
  a.scopeType === b.scopeType &&
  a.discoveryRunId === b.discoveryRunId &&
  a.researchRunId === b.researchRunId &&
  [...a.businessIds].sort().join(",") === [...b.businessIds].sort().join(",") &&
  JSON.stringify(sortKeys(a.filter)) === JSON.stringify(sortKeys(b.filter));

/**
 * Queues a verification + qualification run. Idempotent: the same idempotencyKey returns the same
 * run (also under a race), and an identical run (same scope and AI provider) that is still queued
 * or running is returned instead of a second copy. AI may be chosen only when that provider is
 * ready (owner-enabled, terms confirmed, key present); the worker re-checks before any call.
 */
export async function enqueueQualificationRun(actor: Actor, raw: unknown) {
  if (!can(actor.role, "qualification:run"))
    throw new QualificationError("You do not have permission to start qualification runs", 403);
  const input = startQualificationSchema.parse(raw);

  if (input.idempotencyKey) {
    const prior = await db.qualificationRun.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (prior) return { run: prior, created: false };
  }

  const readiness = await aiReadiness();
  let ai: "none" | AiKind;
  if (input.ai) ai = input.ai;
  else if (readiness.defaultError) throw new QualificationError(readiness.defaultError, 409);
  else ai = readiness.defaultKind;
  if (ai !== "none") {
    const st = readiness.providers.find((p) => p.kind === ai);
    if (!st?.ready)
      throw new QualificationError(
        `AI provider ${ai} is not ready: ${st?.problems.join(" ") ?? "unknown provider"}`,
        409,
      );
  }
  const aiProvider = ai === "none" ? null : MODEL_PROVIDER_IDS[ai];

  const scope = scopeData(input);
  if (scope.discoveryRunId) {
    const dr = await db.discoveryRun.findUnique({
      where: { id: scope.discoveryRunId },
      select: { id: true },
    });
    if (!dr) throw new QualificationError("Discovery run not found", 404);
  }
  if (scope.researchRunId) {
    const rr = await db.researchRun.findUnique({
      where: { id: scope.researchRunId },
      select: { id: true },
    });
    if (!rr) throw new QualificationError("Research run not found", 404);
  }

  const active = await db.qualificationRun.findMany({
    where: { scopeType: scope.scopeType, aiProvider, status: { in: ["queued", "running"] } },
    take: 50,
  });
  const dup = active.find((r) => sameScope(r, scope));
  if (dup) return { run: dup, created: false };

  let run;
  try {
    run = await db.qualificationRun.create({
      data: {
        scopeType: scope.scopeType,
        businessIds: scope.businessIds,
        discoveryRunId: scope.discoveryRunId,
        researchRunId: scope.researchRunId,
        filter: scope.filter ?? Prisma.DbNull,
        aiEnabled: aiProvider !== null,
        aiProvider,
        promptVersion: aiProvider ? readiness.promptVersion : null,
        rulesVersion: QUALIFICATION_RULES_VERSION,
        idempotencyKey: input.idempotencyKey ?? null,
        startedById: actor.id,
        startedByLabel: actor.email,
      },
    });
  } catch (err) {
    if (
      input.idempotencyKey &&
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const prior = await db.qualificationRun.findUniqueOrThrow({
        where: { idempotencyKey: input.idempotencyKey },
      });
      return { run: prior, created: false };
    }
    throw err;
  }
  await recordAudit({
    actorId: actor.id,
    actorLabel: actor.email,
    action: "qualification.run_start",
    entityType: "qualification_run",
    entityId: run.id,
    metadata: {
      scopeType: scope.scopeType,
      ai: aiProvider ?? "none",
      rulesVersion: QUALIFICATION_RULES_VERSION,
      ...(scope.discoveryRunId ? { discoveryRunId: scope.discoveryRunId } : {}),
      ...(scope.researchRunId ? { researchRunId: scope.researchRunId } : {}),
      ...(scope.filter ? { filter: scope.filter } : {}),
      ...(scope.businessIds.length ? { businessCount: scope.businessIds.length } : {}),
    },
  });
  return { run, created: true };
}

/** Parses the start-run form (scope radio + fields) into the API shape. */
export function qualificationFormToInput(fd: FormData): unknown {
  const s = (k: string) => String(fd.get(k) ?? "").trim();
  const common = {
    ai: s("ai") || undefined,
    idempotencyKey: s("idempotencyKey") || undefined,
  };
  const scope = s("scope");
  if (scope === "discovery_run") return { scope, discoveryRunId: s("discoveryRunId"), ...common };
  if (scope === "research_run") return { scope, researchRunId: s("researchRunId"), ...common };
  if (scope === "businesses")
    return { scope, businessIds: fd.getAll("businessIds").map(String), ...common };
  const num = (k: string) => (s(k) ? Number(s(k)) : undefined);
  const website = s("website");
  return {
    scope: "filter",
    filter: {
      category: s("category") || undefined,
      city: s("city") || undefined,
      hasWebsite: website === "yes" ? true : website === "no" ? false : undefined,
      tier: s("tier") || undefined,
      staleAfterDays: num("staleAfterDays"),
      limit: num("limit") ?? 200,
    },
    ...common,
  };
}

// ---------------- manual fact verification ----------------

async function clientIp() {
  try {
    return (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * A person sets a fact's verification status (operator+). Records who, when and why on the fact,
 * keeps the previous automatic result in the evidence, and writes the fact.verify_override audit
 * entry in the same transaction. The automatic pass never changes an overridden fact; the score
 * changes on the next qualification run.
 */
export async function overrideFactVerification(actor: Actor, raw: unknown) {
  if (!can(actor.role, "facts:verify"))
    throw new QualificationError("You do not have permission to override fact verification", 403);
  const input = overrideFactSchema.parse(raw);
  const ipAddress = await clientIp();
  return db.$transaction(async (tx) => {
    const fact = await tx.researchFact.findUnique({ where: { id: input.factId } });
    if (!fact) throw new QualificationError("Fact not found", 404);
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
        verifiedById: actor.id,
        verifiedByLabel: actor.email,
        overrideReason: input.reason,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        actorLabel: actor.email,
        action: "fact.verify_override",
        entityType: "research_fact",
        entityId: fact.id,
        ipAddress,
        metadata: {
          businessId: fact.businessId,
          field: fact.field,
          from: fact.verificationStatus,
          to: input.status,
          reason: input.reason,
        },
      },
    });
    return updated;
  });
}

/** Removes a manual override (operator+); the fact is "unverified" until the next automatic pass. */
export async function clearFactOverride(actor: Actor, raw: unknown) {
  if (!can(actor.role, "facts:verify"))
    throw new QualificationError("You do not have permission to override fact verification", 403);
  const input = clearOverrideSchema.parse(raw);
  const ipAddress = await clientIp();
  return db.$transaction(async (tx) => {
    const fact = await tx.researchFact.findUnique({ where: { id: input.factId } });
    if (!fact) throw new QualificationError("Fact not found", 404);
    if (!fact.verificationOverride) throw new QualificationError("This fact has no override");
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
        actorId: actor.id,
        actorLabel: actor.email,
        action: "fact.verify_override_clear",
        entityType: "research_fact",
        entityId: fact.id,
        ipAddress,
        metadata: {
          businessId: fact.businessId,
          field: fact.field,
          from: fact.verificationStatus,
          previousReason: fact.overrideReason,
          reason: input.reason || null,
        },
      },
    });
    return updated;
  });
}
