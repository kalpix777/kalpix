import type { WebsiteResearchProvider } from "@kalpix/core";
import type { Sleep } from "../rate-limiter";
import {
  DEFAULT_MAX_PAGES,
  HttpResearchProvider,
  MIN_HOST_DELAY_MS,
  PRODUCT_TOKEN,
} from "./http-research";
import { MockResearchProvider } from "./mock-research";
import type { HttpTransport } from "./transport";

export const RESEARCH_PROVIDER_KINDS = ["http", "mock"] as const;
export type ResearchProviderKind = (typeof RESEARCH_PROVIDER_KINDS)[number];

/** Provider descriptor id stored on ResearchRun.provider for each kind. */
export const RESEARCH_PROVIDER_IDS: Record<ResearchProviderKind, string> = {
  http: "http-extractor",
  mock: "mock-research",
};

export function researchKindFromProviderId(id: string): ResearchProviderKind | null {
  const hit = Object.entries(RESEARCH_PROVIDER_IDS).find(([, v]) => v === id);
  return hit ? (hit[0] as ResearchProviderKind) : null;
}

export function resolveResearchKind(env: Record<string, string | undefined>): ResearchProviderKind {
  const raw = (env.RESEARCH_PROVIDER ?? "").trim().toLowerCase() || "http";
  if (!(RESEARCH_PROVIDER_KINDS as readonly string[]).includes(raw))
    throw new Error(
      `RESEARCH_PROVIDER must be one of ${RESEARCH_PROVIDER_KINDS.join(", ")} (got "${raw}")`,
    );
  if (raw === "mock" && env.APP_ENV === "production")
    throw new Error("RESEARCH_PROVIDER=mock is not allowed in production");
  return raw as ResearchProviderKind;
}

/** Identifying User-Agent: product token, version, site and a contact. */
export function researchUserAgent(env: Record<string, string | undefined>): string {
  const contact =
    env.RESEARCH_USER_AGENT_CONTACT?.trim() ||
    env.NOMINATIM_CONTACT_EMAIL?.trim() ||
    "contact not set";
  return `${PRODUCT_TOKEN}/0.1 (+${env.APP_URL || "http://localhost:3000"}; ${contact})`;
}

function intEnv(v: string | undefined, def: number): number {
  const n = Number(v);
  return v?.trim() && Number.isFinite(n) ? Math.floor(n) : def;
}

export type ResearchProviderInstance = WebsiteResearchProvider & { readonly requestsMade: number };

export function createResearchProvider(
  kind: ResearchProviderKind,
  env: Record<string, string | undefined>,
  deps: { transport?: HttpTransport; allowLoopbackForTests?: boolean; sleep?: Sleep } = {},
): ResearchProviderInstance {
  if (kind === "mock") {
    if (env.APP_ENV === "production")
      throw new Error("The mock research provider is not allowed in production");
    return new MockResearchProvider();
  }
  return new HttpResearchProvider({
    userAgent: researchUserAgent(env),
    hostDelayMs: intEnv(env.RESEARCH_HOST_DELAY_MS, MIN_HOST_DELAY_MS),
    maxPages: intEnv(env.RESEARCH_MAX_PAGES, DEFAULT_MAX_PAGES),
    transport: deps.transport,
    allowLoopbackForTests: deps.allowLoopbackForTests,
    appEnv: env.APP_ENV,
    sleep: deps.sleep,
  });
}
