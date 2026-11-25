// Phase 4 job type "research": website research runs, processed from the research_run table with
// the same claim mechanism as discovery (FOR UPDATE SKIP LOCKED, stale-lock recovery, attempts).
import { Prisma, type BusinessStatus, type PrismaClient } from "@prisma/client";
import {
  CONFLICT_FIELDS,
  detectConflicts,
  parseResearchFilter,
  RESEARCH_MAX_BUSINESSES_PER_RUN,
  RESEARCH_SCOPE_TYPES,
  type ResearchScopeType,
  type WebsiteResearchResult,
} from "@kalpix/core";
import {
  createResearchProvider,
  RESEARCH_PROVIDER_IDS,
  researchKindFromProviderId,
  resolveResearchKind,
  type ResearchProviderInstance,
} from "@kalpix/providers";
import { assertProviderUsable, MAX_ATTEMPTS, RunError, STALE_LOCK_MS } from "./process-run";
import { listingFacts, uniqueFacts, websiteFacts, type FactInput } from "./research-mapping";

type Log = (msg: string) => void;
const MAX_STORED_ERRORS = 50;
const BUSINESS_STATUSES = ["NEW", "REVIEWED", "QUALIFIED", "DISQUALIFIED", "ARCHIVED"];

// ---------------- enqueue ----------------

export interface EnqueueResearchInput {
  scopeType: ResearchScopeType;
  businessIds?: string[];
  discoveryRunId?: string;
  filter?: unknown;
  /** Provider descriptor id; defaults to RESEARCH_PROVIDER from the environment. */
  provider?: string;
  idempotencyKey?: string;
  startedById?: string;
  startedByLabel: string;
}

/**
 * Validates the scope and queues a run. The same idempotencyKey returns the existing run
 * (created: false) instead of queueing a second one, also under a concurrent race.
 */
export async function enqueueResearchRun(
  db: PrismaClient,
  input: EnqueueResearchInput,
  env: Record<string, string | undefined> = process.env,
) {
  if (!(RESEARCH_SCOPE_TYPES as readonly string[]).includes(input.scopeType))
    throw new Error(`scopeType must be one of ${RESEARCH_SCOPE_TYPES.join(", ")}`);
  const provider = input.provider ?? RESEARCH_PROVIDER_IDS[resolveResearchKind(env)];
  const kind = researchKindFromProviderId(provider);
  if (!kind) throw new Error(`Unknown research provider ${provider}`);
  if (kind === "mock" && env.APP_ENV === "production")
    throw new Error("The mock research provider is not allowed in production");
  const data: Prisma.ResearchRunCreateInput = {
    provider,
    scopeType: input.scopeType,
    idempotencyKey: input.idempotencyKey ?? null,
    startedByLabel: input.startedByLabel,
    ...(input.startedById ? { startedBy: { connect: { id: input.startedById } } } : {}),
  };
  if (input.scopeType === "businesses") {
    const ids = [...new Set((input.businessIds ?? []).filter((x) => typeof x === "string" && x))];
    if (!ids.length) throw new Error("businessIds is required for scopeType=businesses");
    if (ids.length > RESEARCH_MAX_BUSINESSES_PER_RUN)
      throw new Error(`At most ${RESEARCH_MAX_BUSINESSES_PER_RUN} businesses per run`);
    data.businessIds = ids;
  } else if (input.scopeType === "discovery_run") {
    if (!input.discoveryRunId)
      throw new Error("discoveryRunId is required for scopeType=discovery_run");
    data.discoveryRunId = input.discoveryRunId;
  } else {
    data.filter = parseResearchFilter(input.filter) as Prisma.InputJsonValue;
  }
  if (input.idempotencyKey) {
    const existing = await db.researchRun.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) return { run: existing, created: false };
  }
  try {
    return { run: await db.researchRun.create({ data }), created: true };
  } catch (err) {
    if (
      input.idempotencyKey &&
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const run = await db.researchRun.findUniqueOrThrow({
        where: { idempotencyKey: input.idempotencyKey },
      });
      return { run, created: false };
    }
    throw err;
  }
}

// ---------------- claim ----------------

export async function claimNextResearchRun(
  db: PrismaClient,
  workerId: string,
  staleMs = STALE_LOCK_MS,
): Promise<string | null> {
  const staleBefore = new Date(Date.now() - staleMs);
  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE research_run SET status = 'running', "lockedBy" = ${workerId}, "lockedAt" = now(),
      attempts = attempts + 1, "startedAt" = COALESCE("startedAt", now()), "updatedAt" = now()
    WHERE id = (
      SELECT id FROM research_run
      WHERE status = 'queued' OR (status = 'running' AND "lockedAt" < ${staleBefore})
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id`;
  return rows[0]?.id ?? null;
}

// ---------------- scope ----------------

/** Resolves the run's scope to business ids (capped). Stored on the run once. */
export async function resolveResearchTargets(
  db: PrismaClient,
  run: { scopeType: string; businessIds: string[]; discoveryRunId: string | null; filter: unknown },
  now = new Date(),
): Promise<string[]> {
  const take = RESEARCH_MAX_BUSINESSES_PER_RUN;
  if (run.scopeType === "businesses") {
    const found = await db.business.findMany({
      where: { id: { in: run.businessIds } },
      select: { id: true },
    });
    const ok = new Set(found.map((b) => b.id));
    return run.businessIds.filter((id) => ok.has(id)).slice(0, take); // keep requested order
  }
  if (run.scopeType === "discovery_run") {
    if (!run.discoveryRunId) throw new RunError("Run has no discoveryRunId");
    const rows = await db.business.findMany({
      where: { OR: [{ firstRunId: run.discoveryRunId }, { lastRunId: run.discoveryRunId }] },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take,
    });
    return rows.map((r) => r.id);
  }
  if (run.scopeType === "filter") {
    let f;
    try {
      f = parseResearchFilter(run.filter);
    } catch (err) {
      throw new RunError(err instanceof Error ? err.message : String(err));
    }
    if (f.status && !BUSINESS_STATUSES.includes(f.status))
      throw new RunError(`Unknown business status ${f.status}`);
    const where: Prisma.BusinessWhereInput = {};
    if (f.category) where.category = f.category;
    if (f.city) where.city = { equals: f.city, mode: "insensitive" };
    if (f.status) where.status = f.status as BusinessStatus;
    if (f.hasWebsite !== undefined) where.hasWebsite = f.hasWebsite;
    if (f.staleAfterDays)
      where.OR = [
        { lastResearchedAt: null },
        { lastResearchedAt: { lt: new Date(now.getTime() - f.staleAfterDays * 86_400_000) } },
      ];
    const rows = await db.business.findMany({
      where,
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: Math.min(f.limit ?? take, take),
    });
    return rows.map((r) => r.id);
  }
  throw new RunError(`Unknown scopeType ${run.scopeType}`);
}

// ---------------- limits + usage ----------------

/** Throws RunError when the provider's monthly unit limit is used up (progress is kept). */
async function assertMonthlyBudget(db: PrismaClient, providerId: string) {
  const p = await db.providerConfig.findUnique({ where: { id: providerId } });
  if (!p || p.monthlyLimitUnits == null) return;
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const used = await db.usageEvent.aggregate({
    where: { providerId, createdAt: { gte: monthStart } },
    _sum: { units: true },
  });
  if ((used._sum.units ?? 0) >= p.monthlyLimitUnits)
    throw new RunError(`${p.name} monthly limit of ${p.monthlyLimitUnits} units reached`);
}

// ---------------- per business ----------------

async function upsertFacts(
  tx: Prisma.TransactionClient,
  businessId: string,
  facts: FactInput[],
  runId: string,
) {
  let created = 0;
  for (const f of uniqueFacts(facts)) {
    const where = {
      businessId_field_normalizedValue_sourceUrl: {
        businessId,
        field: f.field,
        normalizedValue: f.normalizedValue,
        sourceUrl: f.sourceUrl,
      },
    };
    const existing = await tx.researchFact.findUnique({ where, select: { id: true } });
    if (existing) {
      // Same value seen again at the same source: refresh observation time and method data.
      // verificationStatus is left to conflict detection / Phase 5 verification.
      await tx.researchFact.update({
        where: { id: existing.id },
        data: {
          value: f.value,
          sourceType: f.sourceType,
          provider: f.provider,
          collectedAt: f.collectedAt,
          confidence: f.confidence,
          usageRestriction: f.usageRestriction ?? null,
          lastRunId: runId,
        },
      });
    } else {
      await tx.researchFact.create({
        data: {
          businessId,
          field: f.field,
          value: f.value,
          normalizedValue: f.normalizedValue,
          sourceUrl: f.sourceUrl,
          sourceType: f.sourceType,
          provider: f.provider,
          collectedAt: f.collectedAt,
          confidence: f.confidence,
          verificationStatus: "unverified",
          usageRestriction: f.usageRestriction ?? null,
          firstRunId: runId,
          lastRunId: runId,
        },
      });
      created++;
    }
  }
  return { written: uniqueFacts(facts).length, created };
}

/**
 * Re-evaluates conflicts over ALL stored facts of the business (not only this run's), moving facts
 * between unverified and conflicting. "verified"/"invalid" (Phase 5 verification) and manual
 * overrides are never changed here.
 */
async function refreshConflicts(tx: Prisma.TransactionClient, businessId: string) {
  const facts = await tx.researchFact.findMany({
    where: { businessId, field: { in: [...CONFLICT_FIELDS] } },
    select: { field: true, normalizedValue: true, sourceType: true },
  });
  const conflicting = [...detectConflicts(facts)].sort();
  if (conflicting.length)
    await tx.researchFact.updateMany({
      where: {
        businessId,
        field: { in: conflicting },
        verificationStatus: "unverified",
        verificationOverride: false,
      },
      data: { verificationStatus: "conflicting" },
    });
  await tx.researchFact.updateMany({
    where: {
      businessId,
      verificationStatus: "conflicting",
      verificationOverride: false, // a person's decision is never reverted here
      ...(conflicting.length ? { field: { notIn: conflicting } } : {}),
    },
    data: { verificationStatus: "unverified" },
  });
  return conflicting;
}

const STATUS_COUNTER = {
  ok: "okCount",
  no_website: "noWebsiteCount",
  broken: "brokenCount",
  blocked: "blockedCount",
} as const;

// ---------------- run ----------------

export interface ResearchDeps {
  provider?: ResearchProviderInstance;
  env?: Record<string, string | undefined>;
  log?: Log;
  /** Test hook: throw after researching this many businesses to simulate a crash. */
  crashAfterBusinesses?: number;
}

/** Processes one claimed research run to completion (or failure). Safe to call again. */
export async function processResearchRun(db: PrismaClient, runId: string, deps: ResearchDeps = {}) {
  const log = deps.log ?? (() => {});
  const env = deps.env ?? process.env;
  const run = await db.researchRun.findUnique({ where: { id: runId } });
  if (!run || run.status !== "running") return run?.status ?? "missing";
  try {
    const kind = researchKindFromProviderId(run.provider);
    if (!kind) throw new RunError(`Unknown research provider ${run.provider}`);
    await assertProviderUsable(db, run.provider, "a research run");
    const provider = deps.provider ?? createResearchProvider(kind, env);
    const hasCatalogueRow = Boolean(
      await db.providerConfig.findUnique({ where: { id: run.provider }, select: { id: true } }),
    );

    // 1. Scope -> business ids, stored once (a resumed run researches the same set).
    let targets = run.targetIds;
    if (!run.resolvedAt) {
      targets = await resolveResearchTargets(db, run);
      await db.researchRun.update({
        where: { id: runId },
        data: { targetIds: targets, totalCount: targets.length, resolvedAt: new Date() },
      });
      log(`research run ${runId}: ${targets.length} business(es) in scope`);
    }

    // 2. One business at a time; each commits atomically with its progress.
    const done = new Set(
      (await db.businessResearch.findMany({ where: { runId }, select: { businessId: true } })).map(
        (r) => r.businessId,
      ),
    );
    let researched = 0;
    for (const businessId of targets) {
      if (done.has(businessId)) continue;
      const current = await db.researchRun.findUnique({
        where: { id: runId },
        select: { status: true },
      });
      if (!current || current.status !== "running") {
        log(`research run ${runId} is ${current?.status ?? "gone"}; stopping`);
        return current?.status ?? "missing";
      }
      if (deps.crashAfterBusinesses !== undefined && researched >= deps.crashAfterBusinesses)
        throw new Error("Simulated crash (test)");
      if (hasCatalogueRow) await assertMonthlyBudget(db, run.provider);
      const business = await db.business.findUnique({ where: { id: businessId } });
      if (!business) {
        // deleted since the scope was resolved: nothing to attach a result to
        await db.researchRun.update({
          where: { id: runId },
          data: { processedCount: { increment: 1 }, lockedAt: new Date() },
        });
        continue;
      }
      const before = provider.requestsMade;
      const r = await provider.research({
        businessId,
        name: business.name,
        website: business.website,
      });
      const requests = r.ok ? r.value.requests : provider.requestsMade - before;
      researched++;

      await db.$transaction(
        async (tx) => {
          let summary: Partial<WebsiteResearchResult> = {};
          let conflictFields: string[] = [];
          let written = 0;
          let created = 0;
          if (r.ok) {
            summary = r.value;
            const facts = [...listingFacts(business), ...websiteFacts(r.value, run.provider)];
            ({ written, created } = await upsertFacts(tx, businessId, facts, runId));
            conflictFields = await refreshConflicts(tx, businessId);
            await tx.business.update({
              where: { id: businessId },
              data: { lastResearchedAt: new Date() },
            });
          }
          const status = r.ok ? r.value.status : "error";
          await tx.businessResearch.create({
            data: {
              runId,
              businessId,
              provider: run.provider,
              status,
              httpStatus: summary.signals?.httpStatus ?? null,
              requestedUrl: summary.signals?.requestedUrl?.slice(0, 2000) ?? business.website,
              finalUrl: summary.signals?.finalUrl?.slice(0, 2000) ?? null,
              signals: (summary.signals as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
              summary: summary.summary ?? null,
              factCount: written,
              conflictFields,
              requestCount: requests,
              error: r.ok ? null : r.error.slice(0, 1000),
            },
          });
          if (hasCatalogueRow && requests > 0)
            await tx.usageEvent.create({
              data: {
                providerId: run.provider,
                operation: "research.fetch",
                units: requests,
                costMinor: 0, // in-house fetcher, no paid API
                isEstimate: false,
                entityType: "research_run",
                entityId: runId,
              },
            });
          const fresh = r.ok
            ? null
            : await tx.researchRun.findUnique({ where: { id: runId }, select: { errors: true } });
          const errors = r.ok
            ? undefined
            : ([
                ...((Array.isArray(fresh?.errors) ? fresh.errors : []) as Prisma.JsonArray),
                { businessId, error: r.error.slice(0, 300) },
              ].slice(-MAX_STORED_ERRORS) as Prisma.InputJsonValue);
          await tx.researchRun.update({
            where: { id: runId },
            data: {
              processedCount: { increment: 1 },
              ...(r.ok
                ? { [STATUS_COUNTER[r.value.status]]: { increment: 1 } }
                : { errorCount: { increment: 1 }, errors }),
              factCount: { increment: written },
              newFactCount: { increment: created },
              conflictCount: { increment: conflictFields.length ? 1 : 0 },
              requestCount: { increment: requests },
              lockedAt: new Date(), // heartbeat
            },
          });
        },
        { timeout: 60_000, maxWait: 10_000 },
      );
      log(`${business.name}: ${r.ok ? r.value.status : `error: ${r.error}`}`);
    }
    await db.researchRun.update({
      where: { id: runId },
      data: { status: "succeeded", finishedAt: new Date(), lockedBy: null, error: null },
    });
    return "succeeded";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!(err instanceof RunError) && msg.startsWith("Simulated crash")) throw err; // test: keep lock
    await db.researchRun.update({
      where: { id: runId },
      data: { status: "failed", error: msg.slice(0, 1000), finishedAt: new Date(), lockedBy: null },
    });
    log(`research run ${runId} failed: ${msg}`);
    return "failed";
  }
}

/** Processes queued research runs until none are left. Returns the number processed. */
export async function drainResearchQueue(
  db: PrismaClient,
  workerId: string,
  deps: ResearchDeps = {},
) {
  let n = 0;
  for (;;) {
    const id = await claimNextResearchRun(db, workerId);
    if (!id) return n;
    const run = await db.researchRun.findUnique({ where: { id }, select: { attempts: true } });
    if ((run?.attempts ?? 0) > MAX_ATTEMPTS) {
      await db.researchRun.update({
        where: { id },
        data: {
          status: "failed",
          error: `Gave up after ${MAX_ATTEMPTS} attempts`,
          finishedAt: new Date(),
          lockedBy: null,
        },
      });
      continue;
    }
    deps.log?.(`processing research run ${id}`);
    await processResearchRun(db, id, deps);
    n++;
  }
}
