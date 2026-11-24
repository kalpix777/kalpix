import { Prisma, type PrismaClient } from "@prisma/client";
import {
  isKalpixCategory,
  parseBBox,
  type BusinessCandidate,
  type KalpixCategory,
  type ResolvedArea,
} from "@kalpix/core";
import {
  boxAround,
  createDiscoveryStack,
  DEFAULT_MAX_DISTANCE_M,
  discoveryKindFromProviderId,
  findDuplicate,
  type DiscoveryStack,
} from "@kalpix/providers";
import { PrismaGeocodeCache } from "./geocode-cache";
import { candidateToCreate, candidateToRefresh, mergeIntoExisting } from "./mapping";

export const STALE_LOCK_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 5;

type Log = (msg: string) => void;

/**
 * Claims the oldest queued run, or a "running" run whose lock went stale (worker crashed), with
 * FOR UPDATE SKIP LOCKED so several workers never take the same run.
 */
export async function claimNextRun(
  db: PrismaClient,
  workerId: string,
  staleMs = STALE_LOCK_MS,
): Promise<string | null> {
  const staleBefore = new Date(Date.now() - staleMs);
  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE discovery_run SET status = 'running', "lockedBy" = ${workerId}, "lockedAt" = now(),
      attempts = attempts + 1, "startedAt" = COALESCE("startedAt", now()), "updatedAt" = now()
    WHERE id = (
      SELECT id FROM discovery_run
      WHERE status = 'queued' OR (status = 'running' AND "lockedAt" < ${staleBefore})
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id`;
  return rows[0]?.id ?? null;
}

export class RunError extends Error {}

async function recordUsage(
  db: PrismaClient,
  providerId: string,
  operation: string,
  units: number,
  runId: string,
) {
  if (units <= 0) return;
  const exists = await db.providerConfig.findUnique({ where: { id: providerId } });
  if (!exists) return; // mock providers have no catalogue row and cost nothing
  await db.usageEvent.create({
    data: {
      providerId,
      operation,
      units,
      costMinor: 0, // free public OSM services
      isEstimate: false,
      entityType: "discovery_run",
      entityId: runId,
    },
  });
}

export async function assertProviderUsable(db: PrismaClient, providerId: string, purpose: string) {
  if (providerId.startsWith("mock-")) {
    if (process.env.APP_ENV === "production")
      throw new RunError("The mock provider is not allowed in production");
    return;
  }
  const p = await db.providerConfig.findUnique({ where: { id: providerId } });
  if (!p) throw new RunError(`Provider ${providerId} is not in the catalogue (run pnpm db:seed)`);
  if (!p.enabled || !p.commercialUseVerified)
    throw new RunError(
      `${p.name} is disabled. The owner must confirm its terms and enable it in AI Provider Settings before ${purpose}.`,
    );
  if (p.monthlyLimitUnits != null) {
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const used = await db.usageEvent.aggregate({
      where: { providerId, createdAt: { gte: monthStart } },
      _sum: { units: true },
    });
    if ((used._sum.units ?? 0) >= p.monthlyLimitUnits)
      throw new RunError(`${p.name} monthly limit of ${p.monthlyLimitUnits} units reached`);
  }
}

export interface ProcessDeps {
  stack?: DiscoveryStack;
  env?: Record<string, string | undefined>;
  log?: Log;
  /** Test hook: throw after this many categories to simulate a crash mid-run. */
  crashAfterCategories?: number;
}

async function upsertCategory(
  tx: Prisma.TransactionClient,
  candidates: BusinessCandidate[],
  runId: string,
) {
  let created = 0;
  let updated = 0;
  let duplicates = 0;
  for (const c of candidates) {
    const same = await tx.business.findUnique({
      where: { provider_providerId: { provider: c.provider, providerId: c.providerId } },
    });
    if (same) {
      await tx.business.update({ where: { id: same.id }, data: candidateToRefresh(c, runId) });
      updated++;
      continue;
    }
    const box = boxAround(c.lat, c.lon, DEFAULT_MAX_DISTANCE_M);
    const near = await tx.business.findMany({
      where: {
        category: c.category,
        lat: { gte: box.minLat, lte: box.maxLat },
        lon: { gte: box.minLon, lte: box.maxLon },
      },
      take: 50,
    });
    const alt = `${c.provider}:${c.providerId}`;
    const already = near.find((n) => n.alternateIds.includes(alt));
    const dup = already ? { match: already } : findDuplicate({ ...c, category: c.category }, near);
    if (dup) {
      await tx.business.update({
        where: { id: dup.match.id },
        data: mergeIntoExisting(dup.match, c, runId),
      });
      duplicates++;
      continue;
    }
    await tx.business.create({ data: candidateToCreate(c, runId) });
    created++;
  }
  return { created, updated, duplicates };
}

/** Processes one claimed run to completion (or failure). Safe to call again on the same run. */
export async function processRun(db: PrismaClient, runId: string, deps: ProcessDeps = {}) {
  const log = deps.log ?? (() => {});
  const env = deps.env ?? process.env;
  const run = await db.discoveryRun.findUnique({ where: { id: runId } });
  if (!run || run.status !== "running") return run?.status ?? "missing";
  try {
    const kind = discoveryKindFromProviderId(run.provider);
    if (!kind) throw new RunError(`Unknown discovery provider ${run.provider}`);
    await assertProviderUsable(db, run.provider, "a discovery run");
    const googleVerified =
      kind === "google-places"
        ? Boolean(
            (await db.providerConfig.findUnique({ where: { id: "google-places" } }))
              ?.commercialUseVerified,
          )
        : false;
    const stack =
      deps.stack ??
      createDiscoveryStack(kind, env, {
        cache: new PrismaGeocodeCache(db),
        googleCommercialVerified: googleVerified,
      });

    // 1. Area -> bbox (stored on the run, so a resumed run never geocodes again).
    let area: ResolvedArea;
    if (
      run.bboxSouth != null &&
      run.bboxWest != null &&
      run.bboxNorth != null &&
      run.bboxEast != null
    ) {
      area = {
        query: run.area,
        displayName: run.areaDisplayName ?? run.area,
        bbox: {
          south: run.bboxSouth,
          west: run.bboxWest,
          north: run.bboxNorth,
          east: run.bboxEast,
        },
        source: run.areaSource ?? "stored",
      };
    } else {
      const explicit = parseBBox(run.area);
      if (explicit) {
        area = {
          query: run.area,
          displayName: `Bounding box ${run.area}`,
          bbox: explicit,
          source: "explicit-bbox",
        };
      } else {
        if (kind !== "mock") await assertProviderUsable(db, "nominatim", "geocoding an area name");
        const before = stack.geocoder.requestsMade;
        const g = await stack.geocoder.geocode(run.area);
        await recordUsage(
          db,
          "nominatim",
          "nominatim.search",
          stack.geocoder.requestsMade - before,
          runId,
        );
        if (!g.ok) throw new RunError(g.error);
        area = g.value.area;
        log(`geocoded "${run.area}" -> ${area.displayName}${g.value.cached ? " (cached)" : ""}`);
      }
      await db.discoveryRun.update({
        where: { id: runId },
        data: {
          areaDisplayName: area.displayName,
          areaSource: area.source,
          bboxSouth: area.bbox.south,
          bboxWest: area.bbox.west,
          bboxNorth: area.bbox.north,
          bboxEast: area.bbox.east,
        },
      });
    }

    // 2. One provider query per category; each category commits atomically with its progress.
    const categories = run.categories.filter(isKalpixCategory) as KalpixCategory[];
    let done = 0;
    for (const cat of categories) {
      const current = await db.discoveryRun.findUnique({
        where: { id: runId },
        select: { status: true, completedCategories: true },
      });
      if (!current || current.status !== "running") {
        log(`run ${runId} is ${current?.status ?? "gone"}; stopping`);
        return current?.status ?? "missing";
      }
      if (current.completedCategories.includes(cat)) continue;
      if (deps.crashAfterCategories !== undefined && done >= deps.crashAfterCategories)
        throw new Error("Simulated crash (test)");
      const before = stack.discovery.requestsMade;
      const r = await stack.discovery.search(area, [cat]);
      const reqs = stack.discovery.requestsMade - before;
      await recordUsage(db, run.provider, "discovery.search", reqs, runId);
      if (!r.ok) {
        await db.discoveryRun.update({
          where: { id: runId },
          data: { requestCount: { increment: reqs } },
        });
        throw new RunError(`${cat}: ${r.error}`);
      }
      await db.$transaction(
        async (tx) => {
          const counts = await upsertCategory(tx, r.value.candidates, runId);
          await tx.discoveryRun.update({
            where: { id: runId },
            data: {
              completedCategories: { push: cat },
              foundCount: { increment: r.value.candidates.length },
              createdCount: { increment: counts.created },
              updatedCount: { increment: counts.updated },
              duplicateCount: { increment: counts.duplicates },
              skippedCount: { increment: r.value.skipped },
              requestCount: { increment: reqs },
              attribution: r.value.attribution ?? null,
              lockedAt: new Date(), // heartbeat
            },
          });
        },
        { timeout: 120_000, maxWait: 10_000 },
      );
      done++;
      log(`${cat}: ${r.value.candidates.length} candidates`);
    }
    await db.discoveryRun.update({
      where: { id: runId },
      data: { status: "succeeded", finishedAt: new Date(), lockedBy: null, error: null },
    });
    return "succeeded";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!(err instanceof RunError) && msg.startsWith("Simulated crash")) throw err; // test: leave lock as-is
    const fresh = await db.discoveryRun.findUnique({
      where: { id: runId },
      select: { attempts: true },
    });
    await db.discoveryRun.update({
      where: { id: runId },
      data: {
        status: "failed",
        error: msg.slice(0, 1000),
        finishedAt: new Date(),
        lockedBy: null,
      },
    });
    log(`run ${runId} failed (attempt ${fresh?.attempts ?? "?"}): ${msg}`);
    return "failed";
  }
}

/** Processes queued runs until none are left. Returns the number processed. */
export async function drainQueue(db: PrismaClient, workerId: string, deps: ProcessDeps = {}) {
  let n = 0;
  for (;;) {
    const id = await claimNextRun(db, workerId);
    if (!id) return n;
    const run = await db.discoveryRun.findUnique({ where: { id }, select: { attempts: true } });
    if ((run?.attempts ?? 0) > MAX_ATTEMPTS) {
      await db.discoveryRun.update({
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
    deps.log?.(`processing run ${id}`);
    await processRun(db, id, deps);
    n++;
  }
}
