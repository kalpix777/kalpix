import { z } from "zod";
import { KALPIX_CATEGORIES, type BBox, type KalpixCategory } from "@kalpix/core";
import rawConfig from "./config/category-tags.json";

/** OSM keys/values are plain identifiers; anything else is rejected so queries cannot be injected. */
const ident = z.string().regex(/^[a-z0-9_:]+$/, "OSM keys and values must be [a-z0-9_:]");

const tagFilter = z.object({ key: ident, values: z.array(ident).min(1) });
export type TagFilter = z.infer<typeof tagFilter>;

const categoryConfig = z.object({ label: z.string().min(1), osm: z.array(tagFilter).min(1) });

export const categoryMapSchema = z
  .object({
    version: z.number().int(),
    note: z.string().optional(),
    categories: z.record(z.string(), categoryConfig),
  })
  .superRefine((cfg, ctx) => {
    for (const c of KALPIX_CATEGORIES)
      if (!cfg.categories[c])
        ctx.addIssue({ code: "custom", path: ["categories", c], message: "missing category" });
    for (const k of Object.keys(cfg.categories))
      if (!(KALPIX_CATEGORIES as readonly string[]).includes(k))
        ctx.addIssue({ code: "custom", path: ["categories", k], message: "unknown category" });
  });
export type CategoryMap = z.infer<typeof categoryMapSchema>;

export function loadCategoryMap(raw: unknown = rawConfig): CategoryMap {
  return categoryMapSchema.parse(raw);
}

export const CATEGORY_MAP: CategoryMap = loadCategoryMap();

/** Categories in config order (the order used for classification), with labels for the UI. */
export function categoryOptions(map: CategoryMap = CATEGORY_MAP) {
  return Object.entries(map.categories).map(([id, c]) => ({
    id: id as KalpixCategory,
    label: c.label,
  }));
}

export function categoryLabel(id: string, map: CategoryMap = CATEGORY_MAP): string {
  return map.categories[id]?.label ?? id;
}

const fmt = (n: number) => Number(n.toFixed(6)).toString();

/** Overpass QL for one or more categories inside a bbox. `out center` gives ways/relations a point. */
export function buildOverpassQuery(
  categories: KalpixCategory[],
  bbox: BBox,
  opts: { timeoutSec?: number; map?: CategoryMap } = {},
): string {
  const map = opts.map ?? CATEGORY_MAP;
  const b = `${fmt(bbox.south)},${fmt(bbox.west)},${fmt(bbox.north)},${fmt(bbox.east)}`;
  const lines: string[] = [];
  for (const cat of categories) {
    const cfg = map.categories[cat];
    if (!cfg) throw new Error(`Unknown category: ${cat}`);
    for (const f of cfg.osm) {
      // Only named features are useful as businesses; filter server-side to reduce load.
      lines.push(`  nwr["${f.key}"~"^(${f.values.join("|")})$"]["name"](${b});`);
    }
  }
  return `[out:json][timeout:${opts.timeoutSec ?? 60}];\n(\n${lines.join("\n")}\n);\nout center tags;`;
}

/**
 * Classifies OSM tags into the first matching Kalpix category (config order), restricted to the
 * categories that were requested. Returns the matched tag as subcategory, e.g. "amenity=cafe".
 */
export function classifyTags(
  tags: Record<string, string>,
  allowed: readonly KalpixCategory[],
  map: CategoryMap = CATEGORY_MAP,
): { category: KalpixCategory; subcategory: string } | null {
  for (const [id, cfg] of Object.entries(map.categories)) {
    if (!allowed.includes(id as KalpixCategory)) continue;
    for (const f of cfg.osm) {
      const v = tags[f.key];
      if (v && f.values.includes(v))
        return { category: id as KalpixCategory, subcategory: `${f.key}=${v}` };
    }
  }
  return null;
}
