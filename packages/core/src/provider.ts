/**
 * Foundation contract every external integration implements (discovery, research,
 * AI models, email, WhatsApp, payments, hosting). Concrete adapters arrive in later phases.
 */
export type ProviderCategory =
  "discovery" | "research" | "model" | "email" | "whatsapp" | "payment" | "hosting" | "storage";

export type CostTier = "free" | "freemium" | "paid";

export interface ProviderDescriptor {
  id: string;
  name: string;
  category: ProviderCategory;
  costTier: CostTier;
  /** Env var names this provider needs; values are never stored here. */
  requiredSecrets: string[];
  /** Commercial use must be confirmed against provider terms before enabling. */
  commercialUseVerified: boolean;
  fallbackProviderId?: string;
}

export type HealthStatus = "connected" | "not_configured" | "error" | "disabled";

export interface ProviderHealth {
  status: HealthStatus;
  checkedAt: Date;
  detail?: string;
}

export interface Provider {
  readonly descriptor: ProviderDescriptor;
  healthCheck(): Promise<ProviderHealth>;
}

/** Explicit result type: no fake success. Failures carry a reason. */
export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const fail = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** A provider is usable only if configured, enabled and cleared for commercial use. */
export function canEnable(
  descriptor: ProviderDescriptor,
  configuredSecrets: ReadonlySet<string>,
): Result<true> {
  const missing = descriptor.requiredSecrets.filter((s) => !configuredSecrets.has(s));
  if (missing.length > 0) return fail(`Missing secrets: ${missing.join(", ")}`);
  if (!descriptor.commercialUseVerified)
    return fail("Commercial-use terms not yet verified for this provider");
  return ok(true);
}
