import { z } from "zod";

/** Empty strings in .env mean "not configured". */
const optionalSecret = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v : undefined));

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
  })
  .superRefine((env, ctx) => {
    if (env.APP_ENV === "production") {
      if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AUTH_SECRET"],
          message: "AUTH_SECRET must be at least 32 characters in production",
        });
      }
      if (env.DATABASE_URL.includes("change-me")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["DATABASE_URL"],
          message: "Default development password is not allowed in production",
        });
      }
      if (env.RAZORPAY_KEY_ID?.startsWith("rzp_test_")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
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
