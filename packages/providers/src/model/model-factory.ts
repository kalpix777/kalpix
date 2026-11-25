import {
  QUALIFICATION_AI_PROVIDERS,
  type ModelProvider,
  type QualificationAiProvider,
} from "@kalpix/core";
import { GeminiModelProvider } from "./gemini";
import { MockModelProvider } from "./mock-model";
import { OllamaModelProvider } from "./ollama";
import type { ModelFetch } from "./shared";

export type ModelProviderKind = Exclude<QualificationAiProvider, "none">;

/** Provider descriptor id stored on QualificationRun.aiProvider for each kind. */
export const MODEL_PROVIDER_IDS: Record<ModelProviderKind, string> = {
  mock: "mock-model",
  ollama: "ollama",
  gemini: "gemini",
};

export function modelKindFromProviderId(id: string): ModelProviderKind | null {
  const hit = Object.entries(MODEL_PROVIDER_IDS).find(([, v]) => v === id);
  return hit ? (hit[0] as ModelProviderKind) : null;
}

export const DEFAULT_PROMPT_VERSION = "qual-v1";

/** QUALIFICATION_AI_PROVIDER: none (default) | mock | ollama | gemini. */
export function resolveQualificationAiKind(
  env: Record<string, string | undefined>,
): QualificationAiProvider {
  const raw = (env.QUALIFICATION_AI_PROVIDER ?? "").trim().toLowerCase() || "none";
  if (!(QUALIFICATION_AI_PROVIDERS as readonly string[]).includes(raw))
    throw new Error(
      `QUALIFICATION_AI_PROVIDER must be one of ${QUALIFICATION_AI_PROVIDERS.join(", ")} (got "${raw}")`,
    );
  if (raw === "mock" && env.APP_ENV === "production")
    throw new Error("QUALIFICATION_AI_PROVIDER=mock is not allowed in production");
  return raw as QualificationAiProvider;
}

export function promptVersion(env: Record<string, string | undefined>): string {
  return env.QUALIFICATION_PROMPT_VERSION?.trim() || DEFAULT_PROMPT_VERSION;
}

/**
 * Builds a model adapter. Throws (no fake success) when its configuration is missing. This does
 * NOT check owner approval: the worker also requires provider_config enabled + commercial-use
 * verified (assertModelProviderUsable) before any call.
 */
export function createModelProvider(
  kind: ModelProviderKind,
  env: Record<string, string | undefined>,
  deps: { fetch?: ModelFetch; timeoutMs?: number } = {},
): ModelProvider {
  if (kind === "mock") return new MockModelProvider({ appEnv: env.APP_ENV });
  if (kind === "ollama") {
    if (!env.OLLAMA_BASE_URL?.trim()) throw new Error("OLLAMA_BASE_URL is not set");
    return new OllamaModelProvider({
      baseUrl: env.OLLAMA_BASE_URL,
      model: env.OLLAMA_MODEL,
      fetch: deps.fetch,
      timeoutMs: deps.timeoutMs,
    });
  }
  if (!env.GEMINI_API_KEY?.trim()) throw new Error("GEMINI_API_KEY is not set");
  return new GeminiModelProvider({
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL,
    fetch: deps.fetch,
    timeoutMs: deps.timeoutMs,
  });
}
