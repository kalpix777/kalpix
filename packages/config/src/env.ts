import { z } from "zod";

/** Empty strings in .env mean "not configured". */
const optionalSecret = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v : undefined));

/** DISCOVERY_PROVIDER values; legacy "osm" / "google-places" are normalised. */
export const DISCOVERY_PROVIDERS = ["overpass", "mock", "google_places"] as const;
const LEGACY_DISCOVERY: Record<string, string> = {
  osm: "overpass",
  "google-places": "google_places",
};

/** RESEARCH_PROVIDER values (Phase 4). */
export const RESEARCH_PROVIDERS = ["http", "mock"] as const;

/** Unset or empty means "use the default". */
const blankToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim().length === 0 ? undefined : v;

export const envSchema = z
  .object({
    APP_ENV: z.enum(["development", "staging", "production"]).default("development"),
    APP_NAME: z.string().default("Kalpix"),
    APP_URL: z.string().url().default("http://localhost:3000"),
    DATABASE_URL: z
      .string()
      .url()
      .refine((v) => v.startsWith("postgres://") || v.startsWith("postgresql://"), {
        message: "DATABASE_URL must be a PostgreSQL connection string",
      }),
    AUTH_SECRET: optionalSecret,
    OLLAMA_BASE_URL: z.string().url().optional(),
    GEMINI_API_KEY: optionalSecret,
    OPENAI_API_KEY: optionalSecret,
    ANTHROPIC_API_KEY: optionalSecret,
    GOOGLE_PLACES_API_KEY: optionalSecret,
    FIRECRAWL_API_KEY: optionalSecret,
    NOMINATIM_CONTACT_EMAIL: optionalSecret,
    RESEND_API_KEY: optionalSecret,
    WHATSAPP_ACCESS_TOKEN: optionalSecret,
    RAZORPAY_KEY_ID: optionalSecret,
    RAZORPAY_KEY_SECRET: optionalSecret,
    RAZORPAY_WEBHOOK_SECRET: optionalSecret,
    CLOUDFLARE_API_TOKEN: optionalSecret,
    // --- Phase 3: discovery + worker ---
    DISCOVERY_PROVIDER: z.preprocess((v) => {
      const b = blankToUndefined(v);
      if (typeof b !== "string") return b;
      const t = b.trim().toLowerCase();
      return LEGACY_DISCOVERY[t] ?? t;
    }, z.enum(DISCOVERY_PROVIDERS).default("overpass")),
    DISCOVERY_MAX_BBOX_DEG2: z.preprocess(
      blankToUndefined,
      z.coerce.number().positive().max(10).default(0.25),
    ),
    NOMINATIM_COUNTRY_CODES: z.preprocess(
      blankToUndefined,
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(
          /^[a-z]{2}(,[a-z]{2})*$/,
          "Use ISO 3166-1 alpha-2 codes, comma separated (e.g. in,np)",
        )
        .default("in"),
    ),
    // --- Phase 4: website research ---
    RESEARCH_PROVIDER: z.preprocess(
      (v) => (typeof blankToUndefined(v) === "string" ? String(v).trim().toLowerCase() : undefined),
      z.enum(RESEARCH_PROVIDERS).default("http"),
    ),
    RESEARCH_MAX_PAGES: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(1).max(20).default(5),
    ),
    RESEARCH_HOST_DELAY_MS: z.preprocess(
      blankToUndefined,
      z.coerce
        .number()
        .int()
        .min(2000, "RESEARCH_HOST_DELAY_MS must be at least 2000 (fair use of small sites)")
        .max(60_000)
        .default(2000),
    ),
    RESEARCH_USER_AGENT_CONTACT: z.preprocess(
      blankToUndefined,
      z
        .string()
        .trim()
        .max(200)
        .refine(
          (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || /^https?:\/\/\S+$/.test(v),
          "RESEARCH_USER_AGENT_CONTACT must be an email address or an http(s) URL",
        )
        .optional(),
    ),
    WORKER_POLL_INTERVAL_MS: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(1000).max(3_600_000).default(5000),
    ),
  })
  .superRefine((env, ctx) => {
    if (env.APP_ENV === "production") {
      if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) {
        ctx.addIssue({
          code: "custom",
          path: ["AUTH_SECRET"],
          message: "AUTH_SECRET must be at least 32 characters in production",
        });
      }
      if (env.DATABASE_URL.includes("change-me")) {
        ctx.addIssue({
          code: "custom",
          path: ["DATABASE_URL"],
          message: "Default development password is not allowed in production",
        });
      }
      if (env.DISCOVERY_PROVIDER === "mock") {
        ctx.addIssue({
          code: "custom",
          path: ["DISCOVERY_PROVIDER"],
          message: "DISCOVERY_PROVIDER=mock is not allowed in production",
        });
      }
      if (env.RESEARCH_PROVIDER === "mock") {
        ctx.addIssue({
          code: "custom",
          path: ["RESEARCH_PROVIDER"],
          message: "RESEARCH_PROVIDER=mock is not allowed in production",
        });
      }
      if (env.RESEARCH_PROVIDER === "http" && !env.RESEARCH_USER_AGENT_CONTACT) {
        ctx.addIssue({
          code: "custom",
          path: ["RESEARCH_USER_AGENT_CONTACT"],
          message:
            "RESEARCH_USER_AGENT_CONTACT is required in production (identifying User-Agent for website research)",
        });
      }
      if (env.RAZORPAY_KEY_ID?.startsWith("rzp_test_")) {
        ctx.addIssue({
          code: "custom",
          path: ["RAZORPAY_KEY_ID"],
          message: "Razorpay test keys are not allowed in production",
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${issues.join("\n")}`);
  }
  return parsed.data;
}

/** Reports which integrations are configured, without ever revealing values. */
export function integrationStatus(env: Env): Record<string, "configured" | "missing"> {
  const keys = [
    "GEMINI_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_PLACES_API_KEY",
    "FIRECRAWL_API_KEY",
    "RESEND_API_KEY",
    "WHATSAPP_ACCESS_TOKEN",
    "RAZORPAY_KEY_ID",
    "CLOUDFLARE_API_TOKEN",
  ] as const;
  return Object.fromEntries(keys.map((k) => [k, env[k] ? "configured" : "missing"]));
}
