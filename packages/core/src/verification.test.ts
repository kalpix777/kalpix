import { describe, expect, it } from "vitest";
import {
  assessOperating,
  checkEmailSyntax,
  checkPhone,
  checkPin,
  pinsInText,
  sourceKey,
  verifyBusinessFacts,
  type MxLookup,
  type MxResolver,
  type VerifiableFact,
} from "./verification";

class FakeMx implements MxResolver {
  lookups = 0;
  constructor(private readonly answers: Record<string, MxLookup>) {}
  async lookup(d: string): Promise<MxLookup> {
    this.lookups++;
    return this.answers[d] ?? { status: "nxdomain" };
  }
}

let n = 0;
function fact(
  p: Partial<VerifiableFact> & { field: string; normalizedValue: string },
): VerifiableFact {
  return {
    id: `f${++n}`,
    value: p.normalizedValue,
    sourceUrl: "https://www.openstreetmap.org/node/1",
    sourceType: "osm",
    provider: "osm-overpass",
    verificationStatus: "unverified",
    verificationOverride: false,
    ...p,
  };
}
const site = (url = "https://sagar.in/", type = "jsonld") => ({
  sourceUrl: url,
  sourceType: type,
  provider: "http-extractor",
});

describe("checkPhone (India)", () => {
  it.each([
    ["+919845012345", true, "mobile"],
    ["+916361234567", true, "mobile"],
    ["+918312461234", true, "mobile_or_landline"],
    ["+912224567890", true, "landline"],
    ["+9118001234567", true, "toll_free"],
    ["+14155550100", true, "foreign"],
  ])("%s is valid (%s)", (p, valid, kind) => {
    expect(checkPhone(p)).toMatchObject({ valid, kind });
  });
  it.each([
    ["+910000000000", /cannot start 0/],
    ["+9198450123", /10 digits/],
    ["+9199999999999", /10 digits/],
    ["+919999999999", /placeholder/],
    ["+911234567890", /placeholder/],
    ["9845012345", /E\.164/],
  ])("%s is invalid", (p, reason) => {
    const c = checkPhone(p);
    expect(c.valid).toBe(false);
    expect(c.reason).toMatch(reason);
  });
});

describe("checkEmailSyntax", () => {
  it("accepts normal and freemail addresses", () => {
    expect(checkEmailSyntax("Hello@Sagar.in")).toMatchObject({
      valid: true,
      domain: "sagar.in",
      freemail: false,
    });
    expect(checkEmailSyntax("sagar.hotel@gmail.com")).toMatchObject({
      valid: true,
      freemail: true,
    });
  });
  it.each([
    ["no-at-sign.in", /not a valid/],
    ["a..b@sagar.in", /not a valid/],
    ["x@-bad.in", /not a valid/],
    ["mock-x@mock.invalid", /reserved/],
    ["info@example.com", /reserved/],
    ["temp@mailinator.com", /disposable/],
    [`${"a".repeat(65)}@sagar.in`, /64/],
  ])("%s is invalid", (e, reason) => {
    const c = checkEmailSyntax(e);
    expect(c.valid).toBe(false);
    expect(c.reason).toMatch(reason);
  });
});

describe("checkPin", () => {
  it("validates format and state prefix", () => {
    expect(checkPin("590006", "Karnataka")).toMatchObject({ valid: true, stateMatch: true });
    expect(checkPin("590006", "Kerala")).toMatchObject({ valid: true, stateMatch: false });
    expect(checkPin("590006", null)).toMatchObject({ valid: true, stateMatch: null });
    expect(checkPin("590006", "Atlantis")).toMatchObject({ valid: true, stateMatch: null });
    expect(checkPin("000000", "Karnataka").valid).toBe(false);
    expect(checkPin("59006", null).valid).toBe(false);
    expect(checkPin("110001", "NCT of Delhi").stateMatch).toBe(true);
  });
  it("finds PINs in addresses", () => {
    expect(pinsInText("1 Test Road, Belagavi 590 006, Karnataka")).toEqual(["590006"]);
    expect(pinsInText("Phone 9845012345")).toEqual([]);
  });
});

describe("sourceKey (independence)", () => {
  it("treats pages of one site as one source and listings per provider", () => {
    expect(sourceKey(site("https://www.sagar.in/"))).toBe(
      sourceKey(site("https://sagar.in/contact", "html")),
    );
    expect(sourceKey({ sourceType: "osm", sourceUrl: "x", provider: "osm-overpass" })).toBe(
      "listing:osm-overpass",
    );
    expect(sourceKey(site("https://other.in/"))).not.toBe(sourceKey(site()));
  });
});

describe("assessOperating", () => {
  it("flags OSM lifecycle and closed tags as closed", () => {
    expect(assessOperating({ "disused:shop": "bakery" }, null).status).toBe("closed");
    expect(assessOperating({ shop: "vacant" }, null).status).toBe("closed");
    expect(assessOperating({ opening_hours: "closed" }, null).status).toBe("closed");
    expect(assessOperating({ end_date: "2020-05" }, null, new Date("2026-01-01")).status).toBe(
      "closed",
    );
    expect(assessOperating({ end_date: "2099" }, null).status).toBe("no_evidence");
    expect(assessOperating({ amenity: "restaurant" }, null).status).toBe("no_evidence");
  });
  it("treats a dead website as a weak hint only", () => {
    const r = assessOperating(
      {},
      {
        id: "r1",
        status: "broken",
        researchedAt: new Date(),
        signals: { noWebsite: false, broken: "dns", requestedUrl: "https://gone.in/" },
      },
    );
    expect(r.status).toBe("possibly_closed");
    expect(r.hints[0]).toMatchObject({ code: "website_gone", strength: "weak" });
    const t = assessOperating(
      {},
      {
        id: "r1",
        status: "broken",
        researchedAt: new Date(),
        signals: { noWebsite: false, broken: "timeout" },
      },
    );
    expect(t.status).toBe("no_evidence");
  });
});

describe("verifyBusinessFacts", () => {
  const business = { id: "b1", state: "Karnataka", website: "https://sagar.in/" };
  const okResearch = {
    id: "r1",
    status: "ok",
    researchedAt: new Date("2026-11-20T00:00:00Z"),
    signals: {
      noWebsite: false,
      requestedUrl: "https://sagar.in/",
      finalUrl: "https://sagar.in/",
      httpStatus: 200,
      https: true,
    },
  };

  it("verifies a phone only when two independent sources agree", async () => {
    const osm = fact({ field: "phone", normalizedValue: "+918312461234" });
    const web = fact({ field: "phone", normalizedValue: "+918312461234", ...site() });
    const samePage = fact({ field: "phone", normalizedValue: "+919845012345", ...site() });
    const sameSite = fact({
      field: "whatsapp",
      normalizedValue: "+919845012345",
      ...site("https://sagar.in/contact", "html"),
    });
    const bad = fact({ field: "phone", normalizedValue: "+910000000000" });
    const r = await verifyBusinessFacts(
      { business, facts: [osm, web, samePage, sameSite, bad], latestResearch: okResearch },
      { mx: new FakeMx({}) },
    );
    const st = Object.fromEntries(r.facts.map((f) => [f.factId, f]));
    expect(st[osm.id]).toMatchObject({ status: "verified", method: "phone_format_agreement" });
    expect(st[osm.id]!.evidence.agreeingFactIds).toEqual([web.id]);
    expect(st[web.id]!.status).toBe("verified");
    // same number twice on one website is ONE source
    expect(st[samePage.id]!.status).toBe("unverified");
    expect(st[sameSite.id]!.status).toBe("unverified");
    expect(st[bad.id]).toMatchObject({ status: "invalid" });
    expect(st[bad.id]!.evidence.reason).toMatch(/cannot start 0/);
    expect(r.summary).toMatchObject({ verified: 2, invalid: 1, rulesVersion: "verify-v1" });
  });

  it("counts a WhatsApp listing as corroboration for the same number from another source", async () => {
    const osm = fact({ field: "phone", normalizedValue: "+919845012345" });
    const wa = fact({ field: "whatsapp", normalizedValue: "+919845012345", ...site() });
    const r = await verifyBusinessFacts(
      { business, facts: [osm, wa], latestResearch: null },
      { mx: new FakeMx({}) },
    );
    expect(r.facts.every((f) => f.status === "verified")).toBe(true);
  });

  it("verifies email with MX + own-domain, rejects reserved/disposable/NXDOMAIN, keeps timeouts unverified", async () => {
    const mx = new FakeMx({
      "sagar.in": { status: "ok", exchanges: ["mx1.sagar.in"] },
      "gmail.com": { status: "ok", exchanges: ["gmail-smtp-in.l.google.com"] },
      "slow.in": { status: "timeout" },
      "nomail.in": { status: "null_mx" },
    });
    const own = fact({ field: "email", normalizedValue: "hello@sagar.in", ...site() });
    const gmail = fact({ field: "email", normalizedValue: "sagar@gmail.com", ...site() });
    const gmail2 = fact({
      field: "email",
      normalizedValue: "sagar@gmail.com",
      ...site("https://sagar.in/contact", "html"),
    });
    const slow = fact({
      field: "email",
      normalizedValue: "a@slow.in",
      ...site("https://sagar.in/about", "html"),
    });
    const gone = fact({
      field: "email",
      normalizedValue: "a@gone-domain.in",
      ...site("https://sagar.in/about", "html"),
    });
    const nullMx = fact({
      field: "email",
      normalizedValue: "a@nomail.in",
      ...site("https://sagar.in/about", "html"),
    });
    const reserved = fact({
      field: "email",
      normalizedValue: "mock-a@mock.invalid",
      ...site("https://sagar.in/about", "html"),
    });
    const disposable = fact({
      field: "email",
      normalizedValue: "x@yopmail.com",
      ...site("https://sagar.in/about", "html"),
    });
    const r = await verifyBusinessFacts(
      {
        business,
        facts: [own, gmail, gmail2, slow, gone, nullMx, reserved, disposable],
        latestResearch: okResearch,
      },
      { mx },
    );
    const st = Object.fromEntries(r.facts.map((f) => [f.factId, f]));
    expect(st[own.id]).toMatchObject({ status: "verified", method: "email_syntax_mx" });
    expect(st[own.id]!.evidence).toMatchObject({ mx: "ok", domainMatchesWebsite: true });
    // gmail twice on the same site: one source, not verified
    expect(st[gmail.id]).toMatchObject({ status: "unverified" });
    expect(st[gmail.id]!.evidence.freemail).toBe(true);
    expect(st[slow.id]!.status).toBe("unverified");
    expect(st[slow.id]!.evidence.reason).toMatch(/timed out/);
    expect(st[gone.id]!.status).toBe("invalid");
    expect(st[nullMx.id]!.status).toBe("invalid");
    expect(st[reserved.id]!.status).toBe("invalid");
    expect(st[disposable.id]!.evidence.reason).toMatch(/disposable/);
    // one lookup per domain; syntax failures never reach DNS
    expect(mx.lookups).toBe(5); // sagar.in, gmail.com, slow.in, gone-domain.in, nomail.in
    expect(r.summary.mxLookups).toBe(5);
  });

  it("verifies a reachable website and invalidates a dead one; robots-blocked stays unverified", async () => {
    const w = fact({ field: "website", normalizedValue: "https://sagar.in/" });
    const ok = await verifyBusinessFacts(
      { business, facts: [w], latestResearch: okResearch },
      { mx: new FakeMx({}) },
    );
    expect(ok.facts[0]).toMatchObject({ status: "verified", method: "website_reachability" });
    expect(ok.facts[0]!.evidence).toMatchObject({ researchId: "r1", https: true, httpStatus: 200 });
    const dead = await verifyBusinessFacts(
      {
        business,
        facts: [w],
        latestResearch: {
          ...okResearch,
          status: "broken",
          signals: {
            noWebsite: false,
            requestedUrl: "https://sagar.in/",
            broken: "http_4xx",
            httpStatus: 404,
          },
        },
      },
      { mx: new FakeMx({}) },
    );
    expect(dead.facts[0]!.status).toBe("invalid");
    const flaky = await verifyBusinessFacts(
      {
        business,
        facts: [w],
        latestResearch: {
          ...okResearch,
          status: "broken",
          signals: {
            noWebsite: false,
            requestedUrl: "https://sagar.in/",
            broken: "http_5xx",
            httpStatus: 503,
          },
        },
      },
      { mx: new FakeMx({}) },
    );
    expect(flaky.facts[0]!.status).toBe("unverified");
    const blocked = await verifyBusinessFacts(
      {
        business,
        facts: [w],
        latestResearch: {
          ...okResearch,
          status: "blocked",
          signals: { noWebsite: false, requestedUrl: "https://sagar.in/", blockedByRobots: true },
        },
      },
      { mx: new FakeMx({}) },
    );
    expect(blocked.facts[0]!.evidence.reason).toMatch(/robots/);
    const none = await verifyBusinessFacts(
      { business, facts: [w], latestResearch: null },
      { mx: new FakeMx({}) },
    );
    expect(none.facts[0]).toMatchObject({ status: "unverified" });
  });

  it("checks postcodes: format, state, agreement incl. PIN inside an address", async () => {
    const osmPin = fact({ field: "postcode", normalizedValue: "590006" });
    const webAddr = fact({
      field: "address",
      normalizedValue: "1 test road belagavi 590006",
      value: "1 Test Road, Belagavi 590006",
      ...site(),
    });
    const zero = fact({
      field: "postcode",
      normalizedValue: "000000",
      sourceType: "listing",
      provider: "mock-discovery",
    });
    const r = await verifyBusinessFacts(
      { business, facts: [osmPin, webAddr, zero], latestResearch: null },
      { mx: new FakeMx({}) },
    );
    const st = Object.fromEntries(r.facts.map((f) => [f.factId, f]));
    expect(st[osmPin.id]).toMatchObject({ status: "verified", method: "postcode_format_state" });
    expect(st[osmPin.id]!.evidence).toMatchObject({ stateMatch: true, cityChecked: false });
    expect(st[zero.id]!.status).toBe("invalid");
    const wrongState = await verifyBusinessFacts(
      { business: { ...business, state: "Kerala" }, facts: [osmPin], latestResearch: null },
      { mx: new FakeMx({}) },
    );
    expect(wrongState.facts[0]!.status).toBe("conflicting");
  });

  it("applies the conflict rule ignoring invalid values, and reverts stale conflicts", async () => {
    const osm = fact({ field: "phone", normalizedValue: "+919900011111" });
    const web = fact({ field: "phone", normalizedValue: "+918312461234", ...site() });
    const r = await verifyBusinessFacts(
      { business, facts: [osm, web], latestResearch: null },
      { mx: new FakeMx({}) },
    );
    expect(r.facts.map((f) => f.status)).toEqual(["conflicting", "conflicting"]);
    // an invalid listing value does not make the website value conflicting
    const bad = fact({
      field: "phone",
      normalizedValue: "+910000000000",
      verificationStatus: "conflicting",
    });
    const web2 = fact({
      field: "phone",
      normalizedValue: "+918312461234",
      verificationStatus: "conflicting",
      ...site(),
    });
    const r2 = await verifyBusinessFacts(
      { business, facts: [bad, web2], latestResearch: null },
      { mx: new FakeMx({}) },
    );
    expect(Object.fromEntries(r2.facts.map((f) => [f.factId, f.status]))).toEqual({
      [bad.id]: "invalid",
      [web2.id]: "unverified",
    });
    // opening hours: conflict check only
    const h1 = fact({ field: "opening_hours", normalizedValue: "mo-sa 09:00-18:00" });
    const h2 = fact({ field: "opening_hours", normalizedValue: "mo-su 10:00-22:00", ...site() });
    const r3 = await verifyBusinessFacts(
      { business, facts: [h1, h2], latestResearch: null },
      { mx: new FakeMx({}) },
    );
    expect(r3.facts.every((f) => f.status === "conflicting" && f.method === "conflict_check")).toBe(
      true,
    );
  });

  it("never touches manual overrides; a manually invalidated value does not corroborate", async () => {
    const osm = fact({
      field: "phone",
      normalizedValue: "+919845012345",
      verificationOverride: true,
      verificationStatus: "invalid",
    });
    const web = fact({ field: "phone", normalizedValue: "+919845012345", ...site() });
    const r = await verifyBusinessFacts(
      { business, facts: [osm, web], latestResearch: null },
      { mx: new FakeMx({}) },
    );
    expect(r.facts.map((f) => f.factId)).toEqual([web.id]);
    expect(r.facts[0]!.status).toBe("unverified");
    expect(r.summary.manual).toBe(1);
  });

  it("is deterministic", async () => {
    const facts = [
      fact({ field: "phone", normalizedValue: "+919845012345" }),
      fact({ field: "phone", normalizedValue: "+919845012345", ...site() }),
      fact({ field: "email", normalizedValue: "hello@sagar.in", ...site() }),
    ];
    const mx = new FakeMx({ "sagar.in": { status: "ok", exchanges: ["mx.sagar.in"] } });
    const a = await verifyBusinessFacts(
      { business, facts, latestResearch: okResearch },
      { mx, now: new Date(0) },
    );
    const b = await verifyBusinessFacts(
      { business, facts, latestResearch: okResearch },
      { mx, now: new Date(0) },
    );
    expect(a).toEqual(b);
  });
});
