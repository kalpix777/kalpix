import "server-only";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { KALPIX_CATEGORIES, RESEARCH_MAX_BUSINESSES_PER_RUN } from "@kalpix/core";
import {
  RESEARCH_PROVIDER_IDS,
  resolveResearchKind,
  type ResearchProviderKind,
} from "@kalpix/providers";
import { db } from "@/lib/db";
import { can } from "@/lib/rbac";
import { recordAudit } from "./audit";

const uuid = z.string().regex(/^[0-9a-f-]{36}$/i, "Must be an id");
const common = {
  /** RESEARCH_PROVIDER-style value; omitted means the configured default. */
  provider: z.enum(["http", "mock"]).optional(),
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9-]{8,64}$/)
    .optional(),
};

export const researchFilterSchema = z
  .object({
    category: z.enum(KALPIX_CATEGORIES).optional(),
    hasWebsite: z.boolean().optional(),
    staleAfterDays: z.number().int().min(1).max(3650).optional(),
    limit: z.number().int().min(1).max(RESEARCH_MAX_BUSINESSES_PER_RUN).default(100),
  })
  .strict();

export const startResearchSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("discovery_run"), discoveryRunId: uuid, ...common }),
  z.object({ scope: z.literal("filter"), filter: researchFilterSchema, ...common }),
  z.object({
    scope: z.literal("businesses"),
    businessIds: z
      .array(uuid)
      .min(1, "Choose at least one business")
      .max(RESEARCH_MAX_BUSINESSES_PER_RUN),
    ...common,
  }),
]);
export type StartResearchInput = z.infer<typeof startResearchSchema>;

interface Actor {
  id: string;
  email: string;
  role?: string | null;
}

export class ResearchError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface ResearchReadiness {
  kind: ResearchProviderKind | null;
  providerId: string | null;
  ready: boolean;
  problems: string[];
  contactSet: boolean;
  enabled?: boolean;
}

/** Whether a research provider can run now. No argument checks the default (RESEARCH_PROVIDER). */
export async function researchReadiness(requested?: string): Promise<ResearchReadiness> {
  let kind: ResearchProviderKind;
  try {
    kind = resolveResearchKind(
      requested ? { ...process.env, RESEARCH_PROVIDER: requested } : process.env,
    );
  } catch (err) {
    return {
      kind: null,
      providerId: null,
      ready: false,
      problems: [(err as Error).message],
      contactSet: false,
    };
  }
  const providerId = RESEARCH_PROVIDER_IDS[kind];
  const contactSet = Boolean((process.env.RESEARCH_USER_AGENT_CONTACT ?? "").trim());
  if (kind === "mock") return { kind, providerId, ready: true, problems: [], contactSet };
  const problems: string[] = [];
  const cfg = await db.providerConfig.findUnique({ where: { id: providerId } });
  const enabled = Boolean(cfg?.enabled && cfg.commercialUseVerified);
  if (!cfg)
    problems.push("The HTTP extractor is not in the provider catalogue (run pnpm db:seed).");
  else if (!enabled)
    problems.push(
      "The HTTP + schema.org extractor is disabled. The owner enables it in AI Provider Settings.",
    );
  if (!contactSet)
    problems.push(
      "Set RESEARCH_USER_AGENT_CONTACT (an email or URL) so website owners can identify and contact KalpixBot.",
    );
  return { kind, providerId, ready: problems.length === 0, problems, contactSet, enabled };
}

function scopeData(input: StartResearchInput) {
  if (input.scope === "businesses")
    return {
      scopeType: "businesses",
      businessIds: [...new Set(input.businessIds)],
      discoveryRunId: null,
      filter: null,
    };
  if (input.scope === "discovery_run")
    return {
      scopeType: "discovery_run",
      businessIds: [] as string[],
      discoveryRunId: input.discoveryRunId,
      filter: null,
    };
  // drop undefined keys so the stored JSON compares equal for identical filters
  const filter = Object.fromEntries(
    Object.entries(input.filter).filter(([, v]) => v !== undefined),
  ) as Record<string, string | number | boolean>;
  return { scopeType: "filter", businessIds: [] as string[], discoveryRunId: null, filter };
}

const sameScope = (
  a: { scopeType: string; businessIds: string[]; discoveryRunId: string | null; filter: unknown },
  b: ReturnType<typeof scopeData>,
) =>
  a.scopeType === b.scopeType &&
  a.discoveryRunId === b.discoveryRunId &&
  [...a.businessIds].sort().join(",") === [...b.businessIds].sort().join(",") &&
  JSON.stringify(sortKeys(a.filter)) === JSON.stringify(sortKeys(b.filter));

function sortKeys(v: unknown): unknown {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v ?? null;
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y)),
  );
}

/**
 * Queues a research run. Idempotent: the same idempotencyKey returns the same run (also under a
 * concurrent race), and an identical run that is still queued or running is returned instead of
 * a second copy.
 */
export async function enqueueResearchRun(actor: Actor, raw: unknown) {
  if (!can(actor.role, "research:run"))
    throw new ResearchError("You do not have permission to start research runs", 403);
  const input = startResearchSchema.parse(raw);

  if (input.idempotencyKey) {
    const prior = await db.researchRun.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (prior) return { run: prior, created: false };
  }

  const readiness = await researchReadiness(input.provider);
  if (!readiness.ready || !readiness.providerId)
    throw new ResearchError(readiness.problems.join(" "), 409);

  const scope = scopeData(input);
  if (scope.discoveryRunId) {
    const dr = await db.discoveryRun.findUnique({
      where: { id: scope.discoveryRunId },
      select: { id: true },
    });
    if (!dr) throw new ResearchError("Discovery run not found", 404);
  }

  const active = await db.researchRun.findMany({
    where: {
      provider: readiness.providerId,
      scopeType: scope.scopeType,
      status: { in: ["queued", "running"] },
    },
    take: 50,
  });
  const dup = active.find((r) => sameScope(r, scope));
  if (dup) return { run: dup, created: false };

  let run;
  try {
    run = await db.researchRun.create({
      data: {
        provider: readiness.providerId,
        scopeType: scope.scopeType,
        businessIds: scope.businessIds,
        discoveryRunId: scope.discoveryRunId,
        filter: scope.filter ?? Prisma.DbNull,
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
      const prior = await db.researchRun.findUniqueOrThrow({
        where: { idempotencyKey: input.idempotencyKey },
      });
      return { run: prior, created: false };
    }
    throw err;
  }
  await recordAudit({
    actorId: actor.id,
    actorLabel: actor.email,
    action: "research.run_start",
    entityType: "research_run",
    entityId: run.id,
    metadata: {
      provider: readiness.providerId,
      scopeType: scope.scopeType,
      ...(scope.discoveryRunId ? { discoveryRunId: scope.discoveryRunId } : {}),
      ...(scope.filter ? { filter: scope.filter } : {}),
      ...(scope.businessIds.length ? { businessCount: scope.businessIds.length } : {}),
    },
  });
  return { run, created: true };
}

/** Parses the start-run form (scope radio + fields) into the API shape. */
export function researchFormToInput(fd: FormData): unknown {
  const s = (k: string) => String(fd.get(k) ?? "").trim();
  const common = {
    provider: s("provider") || undefined,
    idempotencyKey: s("idempotencyKey") || undefined,
  };
  const scope = s("scope");
  if (scope === "discovery_run") return { scope, discoveryRunId: s("discoveryRunId"), ...common };
  if (scope === "businesses")
    return { scope, businessIds: fd.getAll("businessIds").map(String), ...common };
  const num = (k: string) => (s(k) ? Number(s(k)) : undefined);
  const website = s("website");
  return {
    scope: "filter",
    filter: {
      category: s("category") || undefined,
      hasWebsite: website === "yes" ? true : website === "no" ? false : undefined,
      staleAfterDays: num("staleAfterDays"),
      limit: num("limit") ?? 100,
    },
    ...common,
  };
}
