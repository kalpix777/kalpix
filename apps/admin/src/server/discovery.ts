import "server-only";
import { z } from "zod";
import { bboxAreaDeg2, KALPIX_CATEGORIES, parseBBox } from "@kalpix/core";
import {
  DISCOVERY_PROVIDER_IDS,
  discoveryKindFromEnvValue,
  resolveDiscoveryKind,
  type DiscoveryProviderKind,
} from "@kalpix/providers";
import { db } from "@/lib/db";
import { can } from "@/lib/rbac";
import { recordAudit } from "./audit";

export const startRunSchema = z.object({
  area: z.string().trim().min(2, "Enter an area").max(200),
  categories: z
    .array(z.enum(KALPIX_CATEGORIES))
    .min(1, "Choose at least one category")
    .max(KALPIX_CATEGORIES.length),
  /** DISCOVERY_PROVIDER-style value; omitted means the configured default. */
  provider: z.enum(["overpass", "mock", "google_places"]).optional(),
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9-]{8,64}$/)
    .optional(),
});
export type StartRunInput = z.infer<typeof startRunSchema>;

interface Actor {
  id: string;
  email: string;
  role?: string | null;
}

export class DiscoveryError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface DiscoveryReadiness {
  kind: DiscoveryProviderKind | null;
  providerId: string | null;
  ready: boolean;
  problems: string[];
  geocodeReady?: boolean;
  contact?: boolean;
}

/** Providers an operator may pick on the start-run form (mock never in production). */
export function selectableDiscoveryProviders(): ("overpass" | "mock" | "google_places")[] {
  return process.env.APP_ENV === "production"
    ? ["overpass", "google_places"]
    : ["overpass", "mock", "google_places"];
}

/**
 * Whether a provider can run right now (shown on the page). With no argument it checks the
 * configured default (DISCOVERY_PROVIDER).
 */
export async function discoveryReadiness(requested?: string): Promise<DiscoveryReadiness> {
  let kind: DiscoveryProviderKind;
  try {
    if (requested) {
      const k = discoveryKindFromEnvValue(requested);
      if (!k) throw new Error(`Unknown discovery provider "${requested}"`);
      kind = resolveDiscoveryKind({ ...process.env, DISCOVERY_PROVIDER: requested });
    } else {
      kind = resolveDiscoveryKind(process.env);
    }
  } catch (err) {
    return { kind: null, providerId: null, ready: false, problems: [(err as Error).message] };
  }
  const providerId = DISCOVERY_PROVIDER_IDS[kind];
  const problems: string[] = [];
  if (kind === "google-places")
    problems.push(
      "Google Places is a paid adapter that is not built yet. Use OpenStreetMap (DISCOVERY_PROVIDER=overpass).",
    );
  if (kind === "osm") {
    const [overpass, nominatim] = await Promise.all([
      db.providerConfig.findUnique({ where: { id: "osm-overpass" } }),
      db.providerConfig.findUnique({ where: { id: "nominatim" } }),
    ]);
    if (!overpass?.enabled || !overpass.commercialUseVerified)
      problems.push(
        "OpenStreetMap Overpass is disabled. The owner confirms its terms and enables it in AI Provider Settings.",
      );
    const contact = (process.env.NOMINATIM_CONTACT_EMAIL ?? "").trim();
    const geocodeReady = Boolean(nominatim?.enabled && nominatim.commercialUseVerified && contact);
    return {
      kind,
      providerId,
      ready: problems.length === 0,
      problems,
      geocodeReady,
      contact: !!contact,
    };
  }
  return {
    kind,
    providerId,
    ready: problems.length === 0,
    problems,
    geocodeReady: kind === "mock",
    contact: false,
  };
}

/**
 * Queues a discovery run. Idempotent: the same idempotencyKey (one per rendered form) returns the
 * same run, and an identical run that is still queued or running is returned instead of a copy.
 */
export async function enqueueDiscoveryRun(actor: Actor, raw: unknown) {
  if (!can(actor.role, "discovery:run"))
    throw new DiscoveryError("You do not have permission to start discovery runs", 403);
  const input = startRunSchema.parse(raw);
  const categories = [...new Set(input.categories)].sort();

  if (input.idempotencyKey) {
    const prior = await db.discoveryRun.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (prior) return { run: prior, created: false };
  }

  const readiness = await discoveryReadiness(input.provider);
  if (!readiness.ready || !readiness.providerId)
    throw new DiscoveryError(readiness.problems.join(" "), 409);

  const bbox = parseBBox(input.area);
  const max = Number(process.env.DISCOVERY_MAX_BBOX_DEG2 || "0.25");
  if (bbox && bboxAreaDeg2(bbox) > max)
    throw new DiscoveryError(`Bounding box too large (max ${max} square degrees)`);
  if (!bbox && readiness.kind === "osm" && !readiness.geocodeReady)
    throw new DiscoveryError(
      "Area names need Nominatim: set NOMINATIM_CONTACT_EMAIL and have the owner enable Nominatim, or enter a bounding box as south,west,north,east.",
      409,
    );

  const active = await db.discoveryRun.findFirst({
    where: {
      area: input.area,
      provider: readiness.providerId,
      status: { in: ["queued", "running"] },
      categories: { equals: categories },
    },
  });
  if (active) return { run: active, created: false };

  const run = await db.discoveryRun.create({
    data: {
      area: input.area,
      categories,
      provider: readiness.providerId,
      idempotencyKey: input.idempotencyKey ?? null,
      startedById: actor.id,
      startedByLabel: actor.email,
    },
  });
  await recordAudit({
    actorId: actor.id,
    actorLabel: actor.email,
    action: "discovery.run_start",
    entityType: "discovery_run",
    entityId: run.id,
    metadata: { area: input.area, categories, provider: readiness.providerId },
  });
  return { run, created: true };
}
