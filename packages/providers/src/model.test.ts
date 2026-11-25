// Model adapters and MX resolver. No network: fetch and DNS are injected fakes.
import { describe, expect, it, vi } from "vitest";
import { canEnable, qualificationAiOutputSchema } from "@kalpix/core";
import {
  createModelProvider,
  DnsMxResolver,
  GEMINI_DESCRIPTOR,
  GEMINI_FREE_TIER_NOTICE,
  GeminiModelProvider,
  MockModelProvider,
  modelKindFromProviderId,
  OllamaModelProvider,
  OLLAMA_DESCRIPTOR,
  promptVersion,
  resolveQualificationAiKind,
  type ModelFetch,
} from "./index";

const GOOD = {
  summary: "Restaurant with no website.",
  pitchAngle: "A one-page menu site.",
  riskFlags: [],
};
const req = {
  schema: qualificationAiOutputSchema,
  schemaName: "QualificationSuggestion",
  system: "sys",
  prompt: JSON.stringify({ business: { name: "Hotel Sagar", category: "restaurants" } }),
  promptVersion: "qual-v1",
};

function fakeFetch(handler: (url: string, init: RequestInit) => [number, unknown]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f: ModelFetch = async (url, init = {}) => {
    calls.push({ url, init });
    const [status, body] = handler(url, init);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return { f, calls };
}

describe("provider gating", () => {
  it("QUALIFICATION_AI_PROVIDER defaults to none and refuses mock in production", () => {
    expect(resolveQualificationAiKind({})).toBe("none");
    expect(resolveQualificationAiKind({ QUALIFICATION_AI_PROVIDER: " Gemini " })).toBe("gemini");
    expect(() => resolveQualificationAiKind({ QUALIFICATION_AI_PROVIDER: "openai" })).toThrow();
    expect(() =>
      resolveQualificationAiKind({ QUALIFICATION_AI_PROVIDER: "mock", APP_ENV: "production" }),
    ).toThrow(/production/);
    expect(promptVersion({})).toBe("qual-v1");
    expect(modelKindFromProviderId("mock-model")).toBe("mock");
    expect(modelKindFromProviderId("openai")).toBeNull();
  });

  it("mock model is refused in production; real adapters need their config", () => {
    expect(() => new MockModelProvider({ appEnv: "production" })).toThrow(/production/);
    expect(() => createModelProvider("mock", { APP_ENV: "production" })).toThrow(/production/);
    expect(() => createModelProvider("gemini", {})).toThrow(/GEMINI_API_KEY/);
    expect(() => createModelProvider("ollama", {})).toThrow(/OLLAMA_BASE_URL/);
    expect(createModelProvider("ollama", { OLLAMA_BASE_URL: "http://localhost:11434" }).model).toBe(
      "llama3.2:3b",
    );
  });

  it("Gemini and Ollama are not cleared for commercial use by default; Gemini needs its key", () => {
    expect(GEMINI_DESCRIPTOR.commercialUseVerified).toBe(false);
    expect(OLLAMA_DESCRIPTOR.commercialUseVerified).toBe(false);
    expect(canEnable(GEMINI_DESCRIPTOR, new Set()).ok).toBe(false);
    expect(canEnable({ ...GEMINI_DESCRIPTOR, commercialUseVerified: true }, new Set()).ok).toBe(
      false,
    );
    expect(
      canEnable({ ...GEMINI_DESCRIPTOR, commercialUseVerified: true }, new Set(["GEMINI_API_KEY"]))
        .ok,
    ).toBe(true);
    expect(GEMINI_FREE_TIER_NOTICE).toMatch(/training|improve its products/);
  });
});

describe("MockModelProvider", () => {
  it("is deterministic, labelled MOCK and validated by the schema", async () => {
    const m = new MockModelProvider();
    const a = await m.generateStructured(req);
    const b = await m.generateStructured(req);
    expect(a).toEqual(b);
    expect(a.ok && a.value.mock).toBe(true);
    if (a.ok) {
      expect(a.value.data.summary).toMatch(/^MOCK/);
      expect(a.value.data.pitchAngle).toMatch(/^MOCK/);
      expect(a.value.usage.costMinor).toBe(0);
      expect(a.value.usage.inputTokens).toBeGreaterThan(0);
    }
  });
  it("reports malformed output as an error with token usage", async () => {
    const m = new MockModelProvider();
    m.queuedRaw.push("I think this business is great!");
    const r = await m.generateStructured(req);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("malformed_output");
      expect(r.error.usage?.outputTokens).toBeGreaterThan(0);
    }
  });
});

describe("OllamaModelProvider (mocked fetch)", () => {
  it("posts to /api/chat with a JSON schema format and parses the answer", async () => {
    const { f, calls } = fakeFetch(() => [
      200,
      { message: { content: JSON.stringify(GOOD) }, prompt_eval_count: 120, eval_count: 40 },
    ]);
    const p = new OllamaModelProvider({
      baseUrl: "http://127.0.0.1:11434/",
      model: "qwen2.5:7b",
      fetch: f,
    });
    const r = await p.generateStructured(req);
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.value).toMatchObject({
        provider: "ollama",
        model: "qwen2.5:7b",
        mock: false,
        usage: { inputTokens: 120, outputTokens: 40, costMinor: 0, isEstimate: false },
      });
    expect(calls[0]!.url).toBe("http://127.0.0.1:11434/api/chat");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({ model: "qwen2.5:7b", stream: false });
    expect(body.format).toMatchObject({ type: "object" });
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user"]);
  });
  it("maps schema failures, HTTP errors and timeouts", async () => {
    const bad = fakeFetch(() => [200, { message: { content: '{"summary":"x"}' }, eval_count: 5 }]);
    const r1 = await new OllamaModelProvider({
      baseUrl: "http://h:1",
      fetch: bad.f,
    }).generateStructured(req);
    expect(!r1.ok && r1.error.code).toBe("schema_mismatch");
    const down = fakeFetch(() => [500, { error: "model not found" }]);
    const r2 = await new OllamaModelProvider({
      baseUrl: "http://h:1",
      fetch: down.f,
    }).generateStructured(req);
    expect(!r2.ok && r2.error).toMatchObject({ code: "http" });
    expect(!r2.ok && r2.error.message).toMatch(/500.*model not found/);
    const hang: ModelFetch = (_u, init) =>
      new Promise((_, rej) =>
        init?.signal?.addEventListener("abort", () => rej(init.signal?.reason)),
      );
    const r3 = await new OllamaModelProvider({
      baseUrl: "http://h:1",
      fetch: hang,
      timeoutMs: 20,
    }).generateStructured(req);
    expect(!r3.ok && r3.error.code).toBe("timeout");
  });
  it("health check reports a missing model", async () => {
    const { f } = fakeFetch(() => [200, { models: [{ name: "other:1b" }] }]);
    const h = await new OllamaModelProvider({ baseUrl: "http://h:1", fetch: f }).healthCheck();
    expect(h.status).toBe("not_configured");
  });
});

describe("GeminiModelProvider (mocked fetch)", () => {
  const KEY = "test-key-do-not-log";
  it("sends the key in a header (never the URL), asks for JSON and records tokens", async () => {
    const { f, calls } = fakeFetch(() => [
      200,
      {
        candidates: [
          { content: { parts: [{ text: "```json\n" + JSON.stringify(GOOD) + "\n```" }] } },
        ],
        usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 60 },
      },
    ]);
    const p = new GeminiModelProvider({ apiKey: KEY, fetch: f });
    const r = await p.generateStructured(req);
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.value).toMatchObject({
        provider: "gemini",
        model: "gemini-2.5-flash",
        promptVersion: "qual-v1",
        usage: { inputTokens: 300, outputTokens: 60, costMinor: 0 },
      });
    expect(calls[0]!.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect(calls[0]!.url).not.toContain(KEY);
    expect((calls[0]!.init.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.systemInstruction.parts[0].text).toBe("sys");
    expect(p.dataUseNotice).toBe(GEMINI_FREE_TIER_NOTICE);
  });
  it("computes cost only from configured rates", async () => {
    const { f } = fakeFetch(() => [
      200,
      {
        candidates: [{ content: { parts: [{ text: JSON.stringify(GOOD) }] } }],
        usageMetadata: { promptTokenCount: 1_000_000, candidatesTokenCount: 0 },
      },
    ]);
    const r = await new GeminiModelProvider({
      apiKey: KEY,
      fetch: f,
      rates: { inputPerMillionMinor: 700 },
    }).generateStructured(req);
    expect(r.ok && r.value.usage.costMinor).toBe(700);
  });
  it("handles malformed output, blocked prompts, 429 and never leaks the key", async () => {
    const junk = fakeFetch(() => [
      200,
      {
        candidates: [{ content: { parts: [{ text: "Sorry, no." }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
      },
    ]);
    const r1 = await new GeminiModelProvider({ apiKey: KEY, fetch: junk.f }).generateStructured(
      req,
    );
    expect(!r1.ok && r1.error).toMatchObject({
      code: "malformed_output",
      usage: { inputTokens: 10 },
    });
    const blocked = fakeFetch(() => [200, { promptFeedback: { blockReason: "SAFETY" } }]);
    const r2 = await new GeminiModelProvider({ apiKey: KEY, fetch: blocked.f }).generateStructured(
      req,
    );
    expect(!r2.ok && r2.error.code).toBe("refused");
    const limited = fakeFetch(() => [429, { error: { message: `quota exceeded for key ${KEY}` } }]);
    const r3 = await new GeminiModelProvider({ apiKey: KEY, fetch: limited.f }).generateStructured(
      req,
    );
    expect(!r3.ok && r3.error.message).toMatch(/429.*quota/);
    expect(JSON.stringify(r3)).not.toContain(KEY);
    const empty = fakeFetch(() => [200, { candidates: [{ finishReason: "MAX_TOKENS" }] }]);
    const r4 = await new GeminiModelProvider({ apiKey: KEY, fetch: empty.f }).generateStructured(
      req,
    );
    expect(!r4.ok && r4.error.message).toMatch(/MAX_TOKENS/);
  });
  it("refuses a missing key or a model name that could alter the URL", () => {
    expect(() => new GeminiModelProvider({ apiKey: " " })).toThrow(/GEMINI_API_KEY/);
    expect(() => new GeminiModelProvider({ apiKey: KEY, model: "../x?y" })).toThrow(/model/);
  });
});

describe("DnsMxResolver (fake DNS)", () => {
  const err = (code: string) => Object.assign(new Error(code), { code });
  it("maps answers and caches positive and negative results", async () => {
    const resolveMx = vi.fn(async (d: string) => {
      if (d === "sagar.in")
        return [
          { exchange: "mx2.sagar.in", priority: 20 },
          { exchange: "MX1.sagar.in", priority: 10 },
        ];
      if (d === "nomail.in") return [{ exchange: "", priority: 0 }];
      if (d === "nodata.in") throw err("ENODATA");
      throw err("ENOTFOUND");
    });
    const r = new DnsMxResolver({ dns: { resolveMx } });
    expect(await r.lookup("Sagar.in")).toEqual({
      status: "ok",
      exchanges: ["mx1.sagar.in", "mx2.sagar.in"],
    });
    expect(await r.lookup("sagar.in.")).toEqual({
      status: "ok",
      exchanges: ["mx1.sagar.in", "mx2.sagar.in"],
    });
    expect(await r.lookup("nomail.in")).toEqual({ status: "null_mx" });
    expect(await r.lookup("nodata.in")).toEqual({ status: "no_mx" });
    expect(await r.lookup("gone.in")).toEqual({ status: "nxdomain" });
    expect(await r.lookup("gone.in")).toEqual({ status: "nxdomain" });
    expect(resolveMx).toHaveBeenCalledTimes(4);
    expect(r.lookups).toBe(4);
  });
  it("times out without caching, and expires cache entries", async () => {
    let t = 0;
    let hang = true;
    const resolveMx = vi.fn(async () =>
      hang ? new Promise<never>(() => {}) : [{ exchange: "mx.x.in", priority: 1 }],
    );
    const r = new DnsMxResolver({ dns: { resolveMx }, timeoutMs: 100, now: () => t });
    expect(await r.lookup("x.in")).toEqual({ status: "timeout" });
    hang = false;
    expect((await r.lookup("x.in")).status).toBe("ok"); // timeout was not cached
    expect((await r.lookup("x.in")).status).toBe("ok");
    expect(resolveMx).toHaveBeenCalledTimes(2);
    t += 25 * 3600_000;
    await r.lookup("x.in");
    expect(resolveMx).toHaveBeenCalledTimes(3);
  });
  it("turns unexpected resolver errors into a result", async () => {
    const r = new DnsMxResolver({
      dns: {
        resolveMx: async () => {
          throw err("ESERVFAIL");
        },
      },
    });
    expect(await r.lookup("x.in")).toEqual({ status: "error", error: "ESERVFAIL" });
  });
});
