// Phase 5 job type "qualification": verification -> rules scoring -> optional AI, processed from the
// qualification_run table with the same claim mechanism as discovery/research (FOR UPDATE SKIP
// LOCKED, stale-lock recovery, attempts). One business per transaction; resumable; idempotent.
import { Prisma, type BusinessStatus, type PrismaClient } from "@prisma/client";
import {
  buildQualificationPrompt,
  canEnable,
  parseQualificationConfig,
  parseQualificationFilter,
  QUALIFICATION_AI_PROVIDERS,
  QUALIFICATION_MAX_BUSINESSES_PER_RUN,
  QUALIFICATION_RULES_VERSION,
  QUALIFICATION_SCOPE_TYPES,
  qualificationAiOutputSchema,
  sanitizeAiOutput,
  scoreBusiness,
  verifyBusinessFacts,
  type LatestResearch,
  type ModelProvider,
  type MxResolver,
  type QualificationAiProvider,
  type QualificationConfig,
  type QualificationScopeType,
  type WebsiteSignals,
} from "@kalpix/core";
import {
  boxAround,
  createModelProvider,
  DnsMxResolver,
  findDuplicate,
  MOCK_MODEL_DESCRIPTOR,
  MODEL_PROVIDER_IDS,
  modelKindFromProviderId,
  nameSimilarity,
  promptVersion,
  resolveQualificationAiKind,
} from "@kalpix/providers";
import { assertProviderUsable, MAX_ATTEMPTS, RunError, STALE_LOCK_MS } from "./process-run";
import { applyFactVerifications } from "./verification-store";

type Log = (msg: string) => void;
const MAX_STORED_ERRORS = 50;
const BUSINESS_STATUSES = ["NEW", "REVIEWED", "QUALIFIED", "DISQUALIFIED", "ARCHIVED"];
export const QUALIFICATION_SETTING_KEY = "qualification";

// ---------------- enqueue ----------------

export interface EnqueueQualificationInput {
  scopeType: QualificationScopeType;
  businessIds?: string[];
  discoveryRunId?: string;
  researchRunId?: string;
  filter?: unknown;
  /** none | mock | ollama | gemini; defaults to QUALIFICATION_AI_PROVIDER (default none). */
  ai?: QualificationAiProvider;
  idempotencyKey?: string;
  startedById?: string;
  startedByLabel: string;
}

export async function enqueueQualificationRun(
  db: PrismaClient,
  input: EnqueueQualificationInput,
  env: Record<string, string | undefined> = process.env,
) {
  if (!(QUALIFICATION_SCOPE_TYPES as readonly string[]).includes(input.scopeType))
    throw new Error(`scopeType must be one of ${QUALIFICATION_SCOPE_TYPES.join(", ")}`);
  const ai = input.ai ?? resolveQualificationAiKind(env);
  if (!(QUALIFICATION_AI_PROVIDERS as readonly string[]).includes(ai))
    throw new Error(`ai must be one of ${QUALIFICATION_AI_PROVIDERS.join(", ")}`);
  if (ai === "mock" && env.APP_ENV === "production")
    throw new Error("The mock model provider is not allowed in production");
  const data: Prisma.QualificationRunCreateInput = {
    scopeType: input.scopeType,
    idempotencyKey: input.idempotencyKey ?? null,
    aiEnabled: ai !== "none",
    aiProvider: ai === "none" ? null : MODEL_PROVIDER_IDS[ai],
    promptVersion: ai === "none" ? null : promptVersion(env),
    rulesVersion: QUALIFICATION_RULES_VERSION,
    startedByLabel: input.startedByLabel,
    ...(input.startedById ? { startedBy: { connect: { id: input.startedById } } } : {}),
  };
  if (input.scopeType === "businesses") {
    const ids = [...new Set((input.businessIds ?? []).filter((x) => typeof x === "string" && x))];
    if (!ids.length) throw new Error("businessIds is required for scopeType=businesses");
    if (ids.length > QUALIFICATION_MAX_BUSINESSES_PER_RUN)
      throw new Error(`At most ${QUALIFICATION_MAX_BUSINESSES_PER_RUN} businesses per run`);
    data.businessIds = ids;
  } else if (input.scopeType === "discovery_run") {
    if (!input.discoveryRunId)
      throw new Error("discoveryRunId is required for scopeType=discovery_run");
    data.discoveryRunId = input.discoveryRunId;
  } else if (input.scopeType === "research_run") {
    if (!input.researchRunId)
      throw new Error("researchRunId is required for scopeType=research_run");
    data.researchRunId = input.researchRunId;
  } else {
    data.filter = parseQualificationFilter(input.filter) as Prisma.InputJsonValue;
  }
  if (input.idempotencyKey) {
    const existing = await db.qualificationRun.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) return { run: existing, created: false };
  }
  try {
    return { run: await db.qualificationRun.create({ data }), created: true };
  } catch (err) {
    if (
      input.idempotencyKey &&
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const run = await db.qualificationRun.findUniqueOrThrow({
        where: { idempotencyKey: input.idempotencyKey },
      });
      return { run, created: false };
    }
    throw err;
  }
}

// ---------------- claim ----------------

export async function claimNextQualificationRun(
  db: PrismaClient,
  workerId: string,
  staleMs = STALE_LOCK_MS,
): Promise<string | null> {
  const staleBefore = new Date(Date.now() - staleMs);
  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE qualification_run SET status = 'running', "lockedBy" = ${workerId}, "lockedAt" = now(),
      attempts = attempts + 1, "startedAt" = COALESCE("startedAt", now()), "updatedAt" = now()
    WHERE id = (
      SELECT id FROM qualification_run
      WHERE status = 'queued' OR (status = 'running' AND "lockedAt" < ${staleBefore})
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id`;
  return rows[0]?.id ?? null;
}

// ---------------- scope ----------------

export async function resolveQualificationTargets(
  db: PrismaClient,
  run: {
    scopeType: string;
    businessIds: string[];
    discoveryRunId: string | null;
    researchRunId: string | null;
    filter: unknown;
  },
  now = new Date(),
): Promise<string[]> {
  const take = QUALIFICATION_MAX_BUSINESSES_PER_RUN;
  if (run.scopeType === "businesses") {
    const found = await db.business.findMany({
      where: { id: { in: run.businessIds } },
      select: { id: true },
    });
    const ok = new Set(found.map((b) => b.id));
    return run.businessIds.filter((id) => ok.has(id)).slice(0, take);
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
  if (run.scopeType === "research_run") {
    if (!run.researchRunId) throw new RunError("Run has no researchRunId");
    const rows = await db.businessResearch.findMany({
      where: { runId: run.researchRunId },
      select: { businessId: true, business: { select: { createdAt: true } } },
      take,
    });
    return rows
      .sort((a, b) => a.business.createdAt.getTime() - b.business.createdAt.getTime())
      .map((r) => r.businessId);
  }
  if (run.scopeType === "filter") {
    let f;
    try {
      f = parseQualificationFilter(run.filter);
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
    if (f.tier) where.latestTier = f.tier;
    if (f.staleAfterDays)
      where.OR = [
        { qualifiedAt: null },
        { qualifiedAt: { lt: new Date(now.getTime() - f.staleAfterDays * 86_400_000) } },
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

// ---------------- providers, limits, config ----------------

/**
 * A model provider may run only when the owner enabled it, confirmed its commercial terms and its
 * required secrets are present in the environment. MOCK is refused in production.
 */
export async function assertModelProviderUsable(
  db: PrismaClient,
  providerId: string,
  env: Record<string, string | undefined>,
) {
  if (providerId === MOCK_MODEL_DESCRIPTOR.id) {
    if (env.APP_ENV === "production" || process.env.APP_ENV === "production")
      throw new RunError("The mock model provider is not allowed in production");
    return;
  }
  await assertProviderUsable(db, providerId, "an AI qualification run");
  const p = await db.providerConfig.findUniqueOrThrow({ where: { id: providerId } });
  const configured = new Set(p.requiredSecrets.filter((k) => Boolean(env[k]?.trim())));
  const gate = canEnable(
    {
      id: p.id,
      name: p.name,
      category: p.category,
      costTier: p.costTier,
      requiredSecrets: p.requiredSecrets,
      commercialUseVerified: p.commercialUseVerified,
    },
    configured,
  );
  if (!gate.ok) throw new RunError(`${p.name}: ${gate.error}`);
}

async function assertMonthlyBudget(db: PrismaClient, providerId: string) {
  const p = await db.providerConfig.findUnique({ where: { id: providerId } });
  if (!p) return;
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  if (p.monthlyLimitUnits != null || p.monthlyBudgetMinor != null) {
    const used = await db.usageEvent.aggregate({
      where: { providerId, createdAt: { gte: monthStart } },
      _sum: { units: true, costMinor: true },
    });
    if (p.monthlyLimitUnits != null && (used._sum.units ?? 0) >= p.monthlyLimitUnits)
      throw new RunError(`${p.name} monthly limit of ${p.monthlyLimitUnits} units reached`);
    if (p.monthlyBudgetMinor != null && (used._sum.costMinor ?? 0) >= p.monthlyBudgetMinor)
      throw new RunError(`${p.name} monthly budget of ${p.monthlyBudgetMinor} minor units reached`);
  }
}

/** MOCK usage is recorded too (cost 0): its catalogue row is created on first use, outside production. */
async function ensureMockModelCatalogue(db: PrismaClient) {
  await db.providerConfig.upsert({
    where: { id: MOCK_MODEL_DESCRIPTOR.id },
    update: {},
    create: {
      id: MOCK_MODEL_DESCRIPTOR.id,
      name: MOCK_MODEL_DESCRIPTOR.name,
      category: "model",
      costTier: "free",
      enabled: false,
      commercialUseVerified: false,
      requiredSecrets: [],
      notes: "MOCK: tests and CI only. Refused in production. Created by the worker on first use.",
    },
  });
}

export async function loadQualificationConfig(db: PrismaClient): Promise<QualificationConfig> {
  const row = await db.systemSetting.findUnique({ where: { key: QUALIFICATION_SETTING_KEY } });
  try {
    return parseQualificationConfig(row?.value ?? {});
  } catch (err) {
    throw new RunError(
      `Invalid "${QUALIFICATION_SETTING_KEY}" setting: ${err instanceof Error ? err.message : String(err)}`.slice(
        0,
        500,
      ),
    );
  }
}

// ---------------- duplicate check ----------------

const DUP_DISTANCE_M = 50;
const DUP_SAME_PHONE_DISTANCE_M = 2000;

/** An OLDER business this one duplicates: same category nearby with a near-identical name, or the
 *  same valid phone number with a near-identical name within 2 km. The oldest record is kept. */
async function findDuplicateOf(
  db: PrismaClient,
  b: {
    id: string;
    name: string;
    category: string;
    lat: number;
    lon: number;
    createdAt: Date;
    provider: string;
    providerId: string;
  },
  phones: string[],
): Promise<string | null> {
  const box = boxAround(b.lat, b.lon, DUP_DISTANCE_M);
  const near = await db.business.findMany({
    where: {
      id: { not: b.id },
      category: b.category,
      createdAt: { lt: b.createdAt },
      lat: { gte: box.minLat, lte: box.maxLat },
      lon: { gte: box.minLon, lte: box.maxLon },
    },
    select: {
      id: true,
      name: true,
      category: true,
      lat: true,
      lon: true,
      provider: true,
      providerId: true,
    },
    take: 50,
  });
  const hit = findDuplicate(b, near);
  if (hit && hit.reason === "fuzzy") return hit.match.id;
  if (!phones.length) return null;
  const wide = boxAround(b.lat, b.lon, DUP_SAME_PHONE_DISTANCE_M);
  const samePhone = await db.business.findMany({
    where: {
      id: { not: b.id },
      createdAt: { lt: b.createdAt },
      lat: { gte: wide.minLat, lte: wide.maxLat },
      lon: { gte: wide.minLon, lte: wide.maxLon },
      facts: {
        some: {
          field: { in: ["phone", "whatsapp"] },
          normalizedValue: { in: phones },
          verificationStatus: { not: "invalid" },
        },
      },
    },
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
    take: 20,
  });
  return samePhone.find((o) => nameSimilarity(o.name, b.name) >= 0.85)?.id ?? null;
}

// ---------------- run ----------------

export interface QualificationDeps {
  model?: ModelProvider;
  mx?: MxResolver;
  env?: Record<string, string | undefined>;
  log?: Log;
  now?: () => Date;
  /** Test hook: throw after qualifying this many businesses to simulate a crash. */
  crashAfterBusinesses?: number;
}

const TIER_COUNTER = {
  hot: "hotCount",
  warm: "warmCount",
  cold: "coldCount",
  disqualified: "disqualifiedCount",
} as const;

export async function processQualificationRun(
  db: PrismaClient,
  runId: string,
  deps: QualificationDeps = {},
) {
  const log = deps.log ?? (() => {});
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const run = await db.qualificationRun.findUnique({ where: { id: runId } });
  if (!run || run.status !== "running") return run?.status ?? "missing";
  try {
    // 0. AI gating (before any work) and rules config
    let model: ModelProvider | null = null;
    if (run.aiEnabled) {
      if (!run.aiProvider) throw new RunError("aiEnabled without aiProvider");
      const kind = modelKindFromProviderId(run.aiProvider);
      if (!kind) throw new RunError(`Unknown model provider ${run.aiProvider}`);
      await assertModelProviderUsable(db, run.aiProvider, env);
      try {
        model = deps.model ?? createModelProvider(kind, env);
      } catch (err) {
        throw new RunError(err instanceof Error ? err.message : String(err));
      }
      if (kind === "mock") await ensureMockModelCatalogue(db);
    }
    const config = await loadQualificationConfig(db);
    const mx =
      deps.mx ??
      new DnsMxResolver({ timeoutMs: Number(env.VERIFICATION_DNS_TIMEOUT_MS) || undefined });
    const promptVer = run.promptVersion ?? promptVersion(env);

    // 1. Scope -> business ids, stored once
    let targets = run.targetIds;
    if (!run.resolvedAt) {
      targets = await resolveQualificationTargets(db, run, now());
      await db.qualificationRun.update({
        where: { id: runId },
        data: { targetIds: targets, totalCount: targets.length, resolvedAt: now() },
      });
      log(`qualification run ${runId}: ${targets.length} business(es) in scope`);
    }

    const done = new Set(
      (
        await db.businessQualification.findMany({ where: { runId }, select: { businessId: true } })
      ).map((r) => r.businessId),
    );
    let qualified = 0;
    for (const businessId of targets) {
      if (done.has(businessId)) continue;
      const current = await db.qualificationRun.findUnique({
        where: { id: runId },
        select: { status: true },
      });
      if (!current || current.status !== "running") {
        log(`qualification run ${runId} is ${current?.status ?? "gone"}; stopping`);
        return current?.status ?? "missing";
      }
      if (deps.crashAfterBusinesses !== undefined && qualified >= deps.crashAfterBusinesses)
        throw new Error("Simulated crash (test)");
      const business = await db.business.findUnique({ where: { id: businessId } });
      if (!business) {
        await db.qualificationRun.update({
          where: { id: runId },
          data: { processedCount: { increment: 1 }, lockedAt: new Date() },
        });
        continue;
      }
      qualified++;
      const t = now();

      // 2. Verification (DNS outside the transaction)
      const facts = await db.researchFact.findMany({
        where: { businessId },
        orderBy: [{ field: "asc" }, { createdAt: "asc" }],
      });
      const latest = await db.businessResearch.findFirst({
        where: { businessId },
        orderBy: { researchedAt: "desc" },
      });
      const latestResearch: LatestResearch | null = latest
        ? {
            id: latest.id,
            status: latest.status,
            researchedAt: latest.researchedAt,
            signals: (latest.signals as WebsiteSignals | null) ?? null,
            provider: latest.provider,
          }
        : null;
      const verification = await verifyBusinessFacts(
        {
          business: {
            id: business.id,
            state: business.state,
            city: business.city,
            website: business.website,
            rawTags: business.rawTags,
          },
          facts,
          latestResearch,
        },
        { mx, now: t },
      );
      const statusById = new Map(verification.facts.map((v) => [v.factId, v.status]));
      const scoredFacts = facts.map((f) => ({
        id: f.id,
        field: f.field,
        normalizedValue: f.normalizedValue,
        sourceType: f.sourceType,
        verificationStatus: statusById.get(f.id) ?? f.verificationStatus,
      }));

      // 3. Rules score (the only source of score and tier)
      const phones = [
        ...new Set(
          scoredFacts
            .filter(
              (f) =>
                (f.field === "phone" || f.field === "whatsapp") &&
                f.verificationStatus !== "invalid",
            )
            .map((f) => f.normalizedValue),
        ),
      ];
      const duplicateOfId = await findDuplicateOf(db, business, phones);
      const score = scoreBusiness(
        {
          business: {
            id: business.id,
            name: business.name,
            category: business.category,
            source: business.source,
          },
          facts: scoredFacts,
          latestResearch,
          operating: verification.operating,
          duplicateOfId,
          now: t,
        },
        config,
      );

      // 4. Optional AI suggestions (never change the score). Skipped for disqualified businesses.
      let ai: {
        status: "off" | "skipped" | "ok" | "error";
        summary?: string;
        pitch?: string;
        risks?: unknown;
        error?: string;
        model?: string;
        inputTokens?: number;
        outputTokens?: number;
        costMinor?: number;
        isEstimate?: boolean;
        mock?: boolean;
      } = { status: run.aiEnabled ? "skipped" : "off" };
      if (model && score.tier !== "disqualified") {
        await assertMonthlyBudget(db, model.descriptor.id);
        const { system, prompt } = buildQualificationPrompt({
          business: { name: business.name, category: business.category, city: business.city },
          facts: facts.map((f) => ({
            id: f.id,
            field: f.field,
            value: f.value,
            sourceType: f.sourceType,
            verificationStatus: statusById.get(f.id) ?? f.verificationStatus,
          })),
          signals: latestResearch?.signals ?? null,
          researchStatus: latestResearch?.status ?? null,
          score,
          promptVersion: promptVer,
        });
        const r = await model.generateStructured({
          schema: qualificationAiOutputSchema,
          schemaName: "QualificationSuggestion",
          system,
          prompt,
          promptVersion: promptVer,
          maxOutputTokens: 800,
        });
        if (r.ok) {
          const clean = sanitizeAiOutput(r.value.data, new Set(facts.map((f) => f.id)));
          ai = {
            status: "ok",
            summary: clean.output.summary,
            pitch: clean.output.pitchAngle,
            risks: clean.output.riskFlags,
            model: r.value.model,
            inputTokens: r.value.usage.inputTokens,
            outputTokens: r.value.usage.outputTokens,
            costMinor: r.value.usage.costMinor,
            isEstimate: r.value.usage.isEstimate,
            mock: r.value.mock,
            ...(clean.droppedFactIds
              ? { error: `Dropped ${clean.droppedFactIds} fact id(s) not in the input` }
              : {}),
          };
        } else {
          ai = {
            status: "error",
            error: `${r.error.code}: ${r.error.message}`.slice(0, 500),
            model: r.error.model ?? model.model,
            inputTokens: r.error.usage?.inputTokens ?? 0,
            outputTokens: r.error.usage?.outputTokens ?? 0,
            costMinor: r.error.usage?.costMinor ?? 0,
            isEstimate: r.error.usage?.isEstimate ?? true,
            mock: model.descriptor.id === MOCK_MODEL_DESCRIPTOR.id,
          };
        }
      }
      const aiCalled = ai.status === "ok" || ai.status === "error";
      const tokens = (ai.inputTokens ?? 0) + (ai.outputTokens ?? 0);

      // 5. Persist atomically with progress
      await db.$transaction(
        async (tx) => {
          const applied = await applyFactVerifications(tx, verification.facts, t);
          await tx.businessQualification.create({
            data: {
              runId,
              businessId,
              rulesVersion: score.rulesVersion,
              score: score.score,
              tier: score.tier,
              components: score.components as Prisma.InputJsonValue,
              reasons: score.reasons as unknown as Prisma.InputJsonValue,
              disqualifiedReason: score.disqualifiedReason,
              duplicateOfId,
              operatingStatus: verification.operating.status,
              verification: {
                ...verification.summary,
                operatingHints: verification.operating.hints,
              } as unknown as Prisma.InputJsonValue,
              researchId: latestResearch?.id ?? null,
              isMock: score.mock,
              aiStatus: ai.status,
              aiSummary: ai.summary ?? null,
              aiPitch: ai.pitch ?? null,
              aiRisks: (ai.risks as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
              aiError: ai.error ?? null,
              aiProvider: aiCalled ? run.aiProvider : null,
              aiModel: aiCalled ? (ai.model ?? null) : null,
              aiPromptVersion: aiCalled ? promptVer : null,
              aiInputTokens: aiCalled ? (ai.inputTokens ?? 0) : null,
              aiOutputTokens: aiCalled ? (ai.outputTokens ?? 0) : null,
              aiCostMinor: aiCalled ? (ai.costMinor ?? 0) : null,
              aiIsMock: Boolean(ai.mock),
              qualifiedAt: t,
            },
          });
          await tx.business.update({
            where: { id: businessId },
            data: { latestScore: score.score, latestTier: score.tier, qualifiedAt: t },
          });
          if (aiCalled && run.aiProvider)
            await tx.usageEvent.create({
              data: {
                providerId: run.aiProvider,
                operation: "qualification.ai",
                units: Math.max(1, tokens), // tokens (at least 1 per call)
                costMinor: ai.costMinor ?? 0, // 0 for MOCK, local Ollama and the free tier
                isEstimate: Boolean(ai.isEstimate),
                entityType: "qualification_run",
                entityId: runId,
              },
            });
          const errors =
            ai.status === "error"
              ? ([
                  ...(((
                    await tx.qualificationRun.findUnique({
                      where: { id: runId },
                      select: { errors: true },
                    })
                  )?.errors ?? []) as Prisma.JsonArray),
                  { businessId, error: `AI: ${ai.error}`.slice(0, 300) },
                ].slice(-MAX_STORED_ERRORS) as Prisma.InputJsonValue)
              : undefined;
          await tx.qualificationRun.update({
            where: { id: runId },
            data: {
              processedCount: { increment: 1 },
              [TIER_COUNTER[score.tier]]: { increment: 1 },
              factsCheckedCount: { increment: verification.summary.checked },
              factsVerifiedCount: { increment: applied.verified },
              factsInvalidCount: { increment: applied.invalid },
              dnsLookupCount: { increment: verification.summary.mxLookups },
              aiOkCount: { increment: ai.status === "ok" ? 1 : 0 },
              aiErrorCount: { increment: ai.status === "error" ? 1 : 0 },
              aiInputTokens: { increment: ai.inputTokens ?? 0 },
              aiOutputTokens: { increment: ai.outputTokens ?? 0 },
              aiCostMinor: { increment: ai.costMinor ?? 0 },
              ...(errors ? { errors } : {}),
              lockedAt: new Date(), // heartbeat
            },
          });
        },
        { timeout: 60_000, maxWait: 10_000 },
      );
      log(`${business.name}: ${score.tier} ${score.score}${aiCalled ? ` (AI ${ai.status})` : ""}`);
    }
    await db.qualificationRun.update({
      where: { id: runId },
      data: { status: "succeeded", finishedAt: new Date(), lockedBy: null, error: null },
    });
    return "succeeded";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!(err instanceof RunError) && msg.startsWith("Simulated crash")) throw err; // test: keep lock
    await db.qualificationRun.update({
      where: { id: runId },
      data: { status: "failed", error: msg.slice(0, 1000), finishedAt: new Date(), lockedBy: null },
    });
    log(`qualification run ${runId} failed: ${msg}`);
    return "failed";
  }
}

export async function drainQualificationQueue(
  db: PrismaClient,
  workerId: string,
  deps: QualificationDeps = {},
) {
  let n = 0;
  for (;;) {
    const id = await claimNextQualificationRun(db, workerId);
    if (!id) return n;
    const run = await db.qualificationRun.findUnique({ where: { id }, select: { attempts: true } });
    if ((run?.attempts ?? 0) > MAX_ATTEMPTS) {
      await db.qualificationRun.update({
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
    deps.log?.(`processing qualification run ${id}`);
    await processQualificationRun(db, id, deps);
    n++;
  }
}
