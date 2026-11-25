import {
  estimateTokens,
  fail,
  ok,
  parseStructuredOutput,
  type GenerateStructuredRequest,
  type ModelError,
  type ModelProvider,
  type ProviderDescriptor,
  type ProviderHealth,
  type Result,
  type StructuredResult,
} from "@kalpix/core";

export const MOCK_MODEL_DESCRIPTOR: ProviderDescriptor = {
  id: "mock-model",
  name: "Mock model (tests only)",
  category: "model",
  costTier: "free",
  requiredSecrets: [],
  commercialUseVerified: true,
};

type Responder = (req: GenerateStructuredRequest<unknown>) => string;

/**
 * Deterministic offline model for tests and CI (QUALIFICATION_AI_PROVIDER=mock). Makes no
 * request. Every text it produces starts with "MOCK". Its answer still goes through the same JSON
 * parse + zod validation as a real model. Refused when APP_ENV=production.
 */
export class MockModelProvider implements ModelProvider {
  readonly descriptor = MOCK_MODEL_DESCRIPTOR;
  readonly model = "mock-model-1";
  readonly dataUseNotice = "MOCK: fixture output, not a model's judgement.";
  readonly calls: string[] = [];
  /** Test hook: the next answers returned verbatim (e.g. malformed JSON), oldest first. */
  readonly queuedRaw: string[] = [];

  private readonly responder: Responder;

  constructor(opts: { appEnv?: string; responder?: Responder } = {}) {
    this.responder = opts.responder ?? defaultResponder;
    if (opts.appEnv === "production")
      throw new Error("The mock model provider is not allowed in production");
  }

  async healthCheck(): Promise<ProviderHealth> {
    return { status: "connected", checkedAt: new Date(), detail: "mock" };
  }

  async generateStructured<T>(
    req: GenerateStructuredRequest<T>,
  ): Promise<Result<StructuredResult<T>, ModelError>> {
    this.calls.push(req.prompt);
    const raw = this.queuedRaw.shift() ?? this.responder(req as GenerateStructuredRequest<unknown>);
    const usage = {
      inputTokens: estimateTokens(req.system + req.prompt),
      outputTokens: estimateTokens(raw),
      costMinor: 0,
      currency: "INR",
      isEstimate: true,
    };
    const parsed = parseStructuredOutput(raw, req.schema);
    if (!parsed.ok) return fail({ ...parsed.error, usage, model: this.model });
    return ok({
      data: parsed.value,
      provider: this.descriptor.id,
      model: this.model,
      promptVersion: req.promptVersion,
      usage,
      mock: true,
    });
  }
}

/** Qualification-shaped answer derived only from the prompt's own JSON. */
function defaultResponder(req: GenerateStructuredRequest<unknown>): string {
  let p: {
    business?: { name?: string; category?: string };
    rulesScore?: { score?: number; tier?: string; reasons?: string[] };
    facts?: { id: string; field: string; status: string }[];
  } = {};
  try {
    p = JSON.parse(req.prompt);
  } catch {
    // not a qualification prompt
  }
  const name = p.business?.name ?? "business";
  const facts = p.facts ?? [];
  const conflicting = facts.filter((f) => f.status === "conflicting").map((f) => f.id);
  const unverifiedContact = facts
    .filter((f) => ["phone", "whatsapp", "email"].includes(f.field) && f.status !== "verified")
    .map((f) => f.id);
  const riskFlags = [
    ...(conflicting.length
      ? [
          {
            code: "conflicting_data",
            text: "MOCK: sources disagree on some values.",
            factIds: conflicting.slice(0, 10),
          },
        ]
      : []),
    ...(unverifiedContact.length
      ? [
          {
            code: "contact_unverified",
            text: "MOCK: some contact details are not confirmed.",
            factIds: unverifiedContact.slice(0, 10),
          },
        ]
      : []),
  ];
  return JSON.stringify({
    summary: `MOCK summary for ${name} (${p.business?.category ?? "unknown"}): rules tier ${p.rulesScore?.tier ?? "?"}, score ${p.rulesScore?.score ?? "?"}.`,
    pitchAngle: `MOCK pitch: ${p.rulesScore?.reasons?.[0] ?? "offer a website review"}`.slice(
      0,
      400,
    ),
    riskFlags,
  });
}
