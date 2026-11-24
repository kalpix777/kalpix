// Phase 4 research unit tests: HTML fixtures and a fake transport, no network.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  candidatePages,
  classifySocial,
  deobfuscateEmails,
  extractPage,
  findCopyrightYear,
  findEmailsInText,
  findPhonesInText,
  hoursFromSpecification,
  normalizeEmailValue,
  normalizeIndianPhone,
  socialOrMarketplaceHost,
} from "./research/extract";
import { HostRateLimiter, PoliteFetcher } from "./research/fetcher";
import { HttpResearchProvider, MIN_HOST_DELAY_MS } from "./research/http-research";
import { MockResearchProvider } from "./research/mock-research";
import {
  createResearchProvider,
  researchKindFromProviderId,
  researchUserAgent,
  resolveResearchKind,
} from "./research/research-factory";
import { isAllowedByRobots, parseRobots } from "./research/robots";
import { detectTech, parseHttpDate } from "./research/signals";
import { assertUrlAllowed, isBlockedIp, isIpAllowed, SsrfError } from "./research/ssrf";
import {
  classifyNetworkError,
  guardedLookup,
  NodeHttpTransport,
  TransportError,
  type HttpTransport,
  type TransportRequest,
  type TransportResponse,
} from "./research/transport";

const fixture = (n: string) =>
  fs.readFileSync(path.join(__dirname, "__fixtures__/research", n), "utf8");
const NOW = new Date("2026-11-24T10:00:00Z");
const HOME = "https://shreesagar.example.in/";

// ---------- fake transport + clock ----------
type Route = Partial<Omit<TransportResponse, "body">> & {
  body?: string | Buffer;
  error?: TransportError;
};
function fakeTransport(routes: Record<string, Route>) {
  const calls: { url: string; at: number; ua: string }[] = [];
  let clock = 0;
  const transport: HttpTransport = {
    async request(req: TransportRequest) {
      calls.push({ url: req.url.toString(), at: clock, ua: req.headers["user-agent"]! });
      const r = routes[req.url.toString()];
      if (!r)
        return { status: 404, headers: {}, body: Buffer.from(""), truncated: false, timeMs: 5 };
      if (r.error) throw r.error;
      const body = Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body ?? "");
      return {
        status: r.status ?? 200,
        headers: { "content-type": "text/html; charset=utf-8", ...(r.headers ?? {}) },
        body,
        truncated: false,
        timeMs: r.timeMs ?? 42,
      };
    },
  };
  const now = () => clock;
  const sleep = async (ms: number) => {
    clock += ms;
  };
  return { transport, calls, now, sleep };
}

function provider(routes: Record<string, Route>, extra: Record<string, unknown> = {}) {
  const f = fakeTransport(routes);
  const p = new HttpResearchProvider({
    userAgent: "KalpixBot/0.1 (+https://kalpix.test; ops@kalpix.test)",
    transport: f.transport,
    sleep: f.sleep,
    clock: f.now,
    now: () => NOW,
    ...extra,
  });
  return { p, ...f };
}

// ---------- JSON-LD / microdata / meta ----------
describe("extractPage: JSON-LD, meta, links and text", () => {
  const r = extractPage(fixture("home-jsonld.html"), HOME, { isHome: true, now: NOW });
  const get = (field: string) => r.facts.filter((f) => f.field === field);

  it("parses the schema.org LocalBusiness node inside @graph (and skips the broken block)", () => {
    expect(r.jsonLdBlocks).toBe(1);
    expect(r.jsonLdErrors).toBe(1);
    expect(get("name")[0]).toMatchObject({
      value: "Shree Sagar Restaurant",
      sourceType: "jsonld",
      confidence: 0.8,
      sourceUrl: HOME,
    });
    expect(get("phone").map((f) => f.normalizedValue)).toContain("+918312461234");
    expect(get("email").find((f) => f.sourceType === "jsonld")?.normalizedValue).toBe(
      "hello@shreesagar.in",
    );
    expect(get("postcode")[0]?.normalizedValue).toBe("590006");
    expect(get("address")[0]?.value).toBe(
      "12 Congress Road, Tilakwadi, Belagavi, Karnataka, 590006, IN",
    );
    expect(get("geo")[0]?.normalizedValue).toBe("15.84970,74.49770");
    expect(get("opening_hours")[0]?.value).toBe("Mo-Sa 09:00-22:00; Su 10:00-21:00");
    expect(get("price_range")[0]?.value).toBe("₹₹");
    expect(get("website")[0]?.normalizedValue).toBe("shreesagar.example.in");
    expect(get("same_as")[0]?.normalizedValue).toBe("tripadvisor.in/Restaurant_Review-g1-d2");
  });

  it("extracts meta title, description, og tags and page signals", () => {
    expect(get("page_title")[0]?.value).toBe("Shree Sagar Restaurant | Pure Veg, Belagavi");
    expect(get("meta_description")[0]?.sourceType).toBe("meta");
    expect(get("og_site_name")[0]?.value).toBe("Shree Sagar");
    expect(r.hasViewport).toBe(true);
    expect(r.generator).toBe("WordPress 6.5.2");
    expect(r.copyrightYear).toBe(2025);
  });

  it("extracts tel:, wa.me, social profiles and obfuscated emails; ignores share links and scripts", () => {
    const phones = get("phone").map((f) => f.normalizedValue);
    expect(phones).toContain("+919845012345");
    expect(phones).not.toContain("+919999999999"); // inside <script>
    expect(phones.every((p) => /^\+91[2-9]\d{9}$/.test(p))).toBe(true);
    expect(get("whatsapp")[0]?.normalizedValue).toBe("+919845012345");
    expect(get("social_facebook")[0]?.normalizedValue).toBe("https://facebook.com/shreesagarbgm");
    expect(get("social_instagram")[0]?.normalizedValue).toBe(
      "https://instagram.com/shreesagar.bgm",
    );
    expect(get("social_x").map((f) => f.normalizedValue)).toEqual(["https://x.com/shreesagar"]);
    expect(get("social_linkedin")[0]?.normalizedValue).toBe(
      "https://linkedin.com/company/shree-sagar-hospitality",
    );
    expect(get("social_youtube")[0]?.normalizedValue).toBe(
      "https://youtube.com/@shreesagarkitchen",
    );
    expect(get("social_facebook")).toHaveLength(1); // sharer.php skipped
    expect(get("email").map((f) => f.normalizedValue)).toContain("bookings@shreesagar.in");
    expect(get("email").map((f) => f.normalizedValue)).not.toContain("logo@2x.png");
  });

  it("keeps one fact per (field, value, page), highest confidence wins", () => {
    const keys = r.facts.map((f) => `${f.field}|${f.normalizedValue}|${f.sourceUrl}`);
    expect(new Set(keys).size).toBe(keys.length);
    const land = get("phone").find((f) => f.normalizedValue === "+918312461234");
    expect(land?.sourceType).toBe("jsonld"); // also in text at 0.5
  });

  it("finds likely contact/about pages on the same site only", () => {
    expect(candidatePages(r.links, HOME, 4)).toEqual([
      "https://shreesagar.example.in/about-us/",
      "https://shreesagar.example.in/contact",
    ]);
    expect(candidatePages(r.links, HOME, 1)).toHaveLength(1);
  });

  it("parses microdata LocalBusiness with a nested PostalAddress", () => {
    const m = extractPage(fixture("contact-microdata.html"), `${HOME}contact`, { isHome: false });
    const md = m.facts.filter((f) => f.sourceType === "microdata");
    expect(md.map((f) => `${f.field}=${f.normalizedValue}`)).toEqual(
      expect.arrayContaining([
        "name=shree sagar restaurant",
        "phone=+918312469999",
        "email=manager@shreesagar.in",
        "postcode=590006",
        "opening_hours=mo-sa 09:00-22:00",
      ]),
    );
    expect(m.facts.find((f) => f.field === "whatsapp")?.normalizedValue).toBe("+919845099999");
    expect(m.facts.some((f) => f.field === "page_title")).toBe(false); // meta only on homepage
  });
});

describe("normalisers", () => {
  it("normalises Indian phones to E.164", () => {
    expect(normalizeIndianPhone("tel:+91-98450-12345")).toBe("+919845012345");
    expect(normalizeIndianPhone("0831 2461234")).toBe("+918312461234");
    expect(normalizeIndianPhone("+91 (0831) 2461234")).toBe("+918312461234");
    expect(normalizeIndianPhone("12345")).toBeNull();
    expect(normalizeIndianPhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizeIndianPhone("+44 20 7946 0958", { strict: true })).toBeNull();
  });
  it("finds phones in free text conservatively", () => {
    const t = "Call 98450 12345 or 0831-2461234; GST 29ABCDE1234F1Z5; order 1234567890; ₹ 2,50,000";
    expect(findPhonesInText(t).map((p) => p.e164)).toEqual(["+919845012345", "+918312461234"]);
  });
  it("validates and de-obfuscates emails", () => {
    expect(normalizeEmailValue("mailto:Info@Shop.IN?subject=hi")).toBe("info@shop.in");
    expect(normalizeEmailValue("you@example.com")).toBeNull();
    expect(normalizeEmailValue("icon@2x.png")).toBeNull();
    expect(deobfuscateEmails("a [at] b [dot] in")).toBe("a@b.in");
    expect(findEmailsInText("mail: sales(at)kumar(dot)co.in or info at kumar dot in")).toEqual([
      "sales@kumar.co.in",
      "info@kumar.in",
    ]);
  });
  it("classifies social links and WhatsApp numbers", () => {
    expect(classifySocial("https://m.facebook.com/profile.php?id=1234")).toEqual({
      kind: "social",
      field: "social_facebook",
      url: "https://facebook.com/profile.php?id=1234",
    });
    expect(classifySocial("https://api.whatsapp.com/send?phone=9845012345")).toEqual({
      kind: "whatsapp",
      phone: "+919845012345",
    });
    expect(classifySocial("https://www.instagram.com/p/abc123/")).toBeNull();
    expect(classifySocial("https://www.linkedin.com/shareArticle?url=x")).toBeNull();
    expect(classifySocial("https://www.youtube.com/watch?v=abc")).toBeNull();
    expect(classifySocial("https://www.youtube.com/channel/UCAbC")?.kind).toBe("social");
    expect(classifySocial("https://example.in/contact")).toBeNull();
  });
  it("recognises listed 'websites' that are social or marketplace profiles", () => {
    expect(socialOrMarketplaceHost("https://www.facebook.com/somebiz")).toBe("facebook.com");
    expect(socialOrMarketplaceHost("https://www.justdial.com/Belgaum/x")).toBe("justdial.com");
    expect(socialOrMarketplaceHost("https://shop.example.in")).toBeNull();
  });
  it("merges openingHoursSpecification into OSM-style ranges", () => {
    expect(
      hoursFromSpecification([
        { dayOfWeek: ["Monday", "Tuesday", "Wednesday"], opens: "09:00", closes: "18:00" },
        { dayOfWeek: "Friday", opens: "09:00", closes: "18:00" },
      ]),
    ).toBe("Mo-We 09:00-18:00; Fr 09:00-18:00");
    expect(hoursFromSpecification({})).toBeNull();
  });
  it("reads copyright years sanely", () => {
    expect(findCopyrightYear("© 2012–2024 Foo", NOW)).toBe(2024);
    expect(findCopyrightYear("Copyright 1890", NOW)).toBeUndefined();
    expect(findCopyrightYear("(c) 2031", NOW)).toBeUndefined();
  });
});

// ---------- tech + signals ----------
describe("tech detection", () => {
  it("detects platforms from HTML, generator and headers", () => {
    expect(detectTech(fixture("home-jsonld.html"), {}, "WordPress 6.5.2")).toContain("WordPress");
    expect(detectTech(fixture("plain-wix.html"), {}, undefined)).toEqual(["Wix"]);
    expect(detectTech("<html></html>", { "x-shopid": "1", "cf-ray": "x" })).toEqual([
      "Cloudflare",
      "Shopify",
    ]);
    expect(detectTech("<html></html>", {}, "Blogger")).toEqual(["Blogger"]);
    expect(detectTech('<script id="__NEXT_DATA__">', { "x-powered-by": "PHP/8.1" })).toEqual([
      "Next.js",
      "PHP",
    ]);
  });
  it("parses Last-Modified", () => {
    expect(parseHttpDate("Wed, 21 Oct 2025 07:28:00 GMT")).toBe("2025-10-21T07:28:00.000Z");
    expect(parseHttpDate("garbage")).toBeUndefined();
  });
});

// ---------- robots.txt ----------
describe("robots.txt", () => {
  const txt = `
# comment
User-agent: *
Disallow: /private
Allow: /private/contact
Disallow: /*.php$
Crawl-delay: 4

User-agent: BadBot
Disallow: /
`;
  it("applies the * group, longest match, Allow on tie, wildcards and $", () => {
    const p = parseRobots(txt, "KalpixBot");
    expect(p.crawlDelaySeconds).toBe(4);
    expect(isAllowedByRobots(p, "/")).toBe(true);
    expect(isAllowedByRobots(p, "/private/x")).toBe(false);
    expect(isAllowedByRobots(p, "/private/contact")).toBe(true);
    expect(isAllowedByRobots(p, "/index.php")).toBe(false);
    expect(isAllowedByRobots(p, "/index.php?x=1")).toBe(true);
  });
  it("prefers a group naming our product token", () => {
    const p = parseRobots(
      "User-agent: *\nDisallow: /\n\nUser-agent: kalpixbot\nDisallow: /admin",
      "KalpixBot",
    );
    expect(isAllowedByRobots(p, "/contact")).toBe(true);
    expect(isAllowedByRobots(p, "/admin")).toBe(false);
  });
  it("treats an empty Disallow as allow-all and shares rules across stacked agents", () => {
    expect(isAllowedByRobots(parseRobots("User-agent: *\nDisallow:", "KalpixBot"), "/x")).toBe(
      true,
    );
    const p = parseRobots("User-agent: a\nUser-agent: *\nDisallow: /x", "KalpixBot");
    expect(isAllowedByRobots(p, "/x/1")).toBe(false);
  });
});

// ---------- SSRF ----------
describe("SSRF guard", () => {
  it("blocks private, loopback, link-local, CGNAT, multicast and mapped addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "64:ff9b::a00:1",
    ])
      expect(isBlockedIp(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "103.21.244.1", "2606:4700::6810:84e5", "::ffff:8.8.8.8"])
      expect(isBlockedIp(ip), ip).toBe(false);
  });
  it("allows loopback only under the explicit test policy", () => {
    expect(isIpAllowed("127.0.0.1")).toBe(false);
    expect(isIpAllowed("127.0.0.1", { allowLoopback: true })).toBe(true);
    expect(isIpAllowed("10.0.0.1", { allowLoopback: true })).toBe(false);
  });
  it("rejects bad schemes, credentials, internal names, odd ports and private literals", () => {
    const bad = [
      "file:///etc/passwd",
      "ftp://example.com/",
      "http://user:pw@example.com/",
      "http://localhost/",
      "http://intranet/",
      "http://printer.local/",
      "http://metadata.google.internal/",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/",
      "http://example.com:22/",
      "http://2130706433/", // decimal 127.0.0.1 (URL parser canonicalises)
    ];
    for (const u of bad) expect(() => assertUrlAllowed(u), u).toThrow(SsrfError);
    expect(assertUrlAllowed("https://shop.example.in:8443/a").hostname).toBe("shop.example.in");
    expect(() => assertUrlAllowed("http://127.0.0.1:5555/", { allowLoopback: true })).not.toThrow();
  });
  it("refuses private literals before connecting", async () => {
    const t = new NodeHttpTransport();
    await expect(
      t.request({ url: new URL("http://127.0.0.1/"), headers: {}, timeoutMs: 1000, maxBytes: 10 }),
    ).rejects.toThrow(SsrfError);
  });
  it("refuses at connect time a hostname resolving (or rebinding) to a private address", async () => {
    const fakeDns = ((host: string, _o: unknown, cb: (e: null, a: unknown) => void) =>
      cb(null, [
        { address: "93.184.216.34", family: 4 },
        { address: host === "rebind.example.in" ? "10.0.0.5" : "93.184.216.35", family: 4 },
      ])) as unknown as typeof import("node:dns").lookup;
    const lookup = guardedLookup({}, fakeDns);
    const run = (h: string) =>
      new Promise<unknown>((resolve) =>
        lookup(h, { all: true }, (err, addrs) => resolve(err ?? addrs)),
      );
    expect(await run("rebind.example.in")).toBeInstanceOf(SsrfError);
    expect(await run("ok.example.in")).toHaveLength(2);
    // through the real transport: the socket never connects
    const t = new NodeHttpTransport({}, fakeDns);
    await expect(
      t.request({
        url: new URL("http://rebind.example.in/"),
        headers: {},
        timeoutMs: 2000,
        maxBytes: 10,
      }),
    ).rejects.toMatchObject({ kind: "ssrf_blocked" });
  });
  it("classifies network errors", () => {
    expect(classifyNetworkError(Object.assign(new Error("x"), { code: "ENOTFOUND" })).kind).toBe(
      "dns",
    );
    expect(
      classifyNetworkError(Object.assign(new Error("x"), { code: "CERT_HAS_EXPIRED" })).kind,
    ).toBe("tls");
    expect(classifyNetworkError(new SsrfError("no")).kind).toBe("ssrf_blocked");
    expect(classifyNetworkError(Object.assign(new Error("x"), { code: "ECONNREFUSED" })).kind).toBe(
      "network",
    );
  });
});

// ---------- polite fetcher ----------
describe("PoliteFetcher", () => {
  const ua = "KalpixBot/0.1 (+https://kalpix.test; ops@kalpix.test)";
  const mk = (routes: Record<string, Route>, hostDelayMs = 2000) => {
    const f = fakeTransport(routes);
    return {
      fetcher: new PoliteFetcher({
        transport: f.transport,
        userAgent: ua,
        productToken: "KalpixBot",
        hostDelayMs,
        now: f.now,
        sleep: f.sleep,
      }),
      ...f,
    };
  };

  it("reads robots.txt once per origin, sends the identifying UA and spaces requests per host", async () => {
    const { fetcher, calls } = mk({
      "https://a.example.in/robots.txt": { body: "User-agent: *\nCrawl-delay: 5" },
      "https://a.example.in/": { body: "<html></html>" },
      "https://a.example.in/contact": { body: "<html></html>" },
    });
    expect((await fetcher.fetchPage("https://a.example.in/")).ok).toBe(true);
    expect((await fetcher.fetchPage("https://a.example.in/contact")).ok).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      "https://a.example.in/robots.txt",
      "https://a.example.in/",
      "https://a.example.in/contact",
    ]);
    expect(calls.every((c) => c.ua === ua)).toBe(true);
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(2000);
    expect(calls[2]!.at - calls[1]!.at).toBeGreaterThanOrEqual(5000); // Crawl-delay 5 > 2 s floor
    expect(fetcher.requests).toBe(3);
  });

  it("honours Disallow and treats robots 4xx as allow-all, 5xx as unavailable", async () => {
    const a = mk({ "https://b.example.in/robots.txt": { body: "User-agent: *\nDisallow: /" } });
    expect(await a.fetcher.fetchPage("https://b.example.in/")).toMatchObject({
      ok: false,
      kind: "robots",
    });
    expect(a.calls).toHaveLength(1);
    const b = mk({ "https://c.example.in/": { body: "<html/>" } }); // robots 404
    expect((await b.fetcher.fetchPage("https://c.example.in/")).ok).toBe(true);
    const c = mk({ "https://d.example.in/robots.txt": { status: 503 } });
    expect(await c.fetcher.fetchPage("https://d.example.in/")).toMatchObject({
      ok: false,
      kind: "http_5xx",
    });
  });

  it("follows up to 5 redirects, re-checking SSRF on each hop", async () => {
    const { fetcher } = mk({
      "http://e.example.in/": { status: 301, headers: { location: "https://e.example.in/" } },
      "https://e.example.in/": {
        status: 302,
        headers: { location: "http://169.254.169.254/latest" },
      },
    });
    expect(await fetcher.fetchPage("http://e.example.in/")).toMatchObject({
      ok: false,
      kind: "ssrf_blocked",
      redirects: 2,
    });
    const loop: Record<string, Route> = {};
    for (let i = 0; i < 7; i++)
      loop[`https://f.example.in/${i}`] = { status: 302, headers: { location: `/${i + 1}` } };
    expect(await mk(loop).fetcher.fetchPage("https://f.example.in/0")).toMatchObject({
      ok: false,
      kind: "too_many_redirects",
    });
  });

  it("classifies 4xx/5xx pages and transport failures", async () => {
    const { fetcher } = mk({
      "https://g.example.in/": { status: 410 },
      "https://h.example.in/robots.txt": {
        error: new TransportError("dns", "DNS lookup failed (ENOTFOUND)"),
      },
    });
    expect(await fetcher.fetchPage("https://g.example.in/")).toMatchObject({
      ok: false,
      kind: "http_4xx",
      status: 410,
    });
    expect(await fetcher.fetchPage("https://h.example.in/")).toMatchObject({
      ok: false,
      kind: "dns",
    });
    expect(await fetcher.fetchPage("not a url")).toMatchObject({ ok: false, kind: "invalid_url" });
  });

  it("HostRateLimiter keeps hosts independent", async () => {
    let t = 0;
    const lim = new HostRateLimiter(
      () => t,
      async (ms) => void (t += ms),
    );
    const starts: string[] = [];
    await lim.schedule("a", 2000, async () => void starts.push(`a@${t}`));
    await lim.schedule("b", 2000, async () => void starts.push(`b@${t}`));
    await lim.schedule("a", 2000, async () => void starts.push(`a@${t}`));
    expect(starts).toEqual(["a@0", "b@0", "a@2000"]);
  });
});

// ---------- provider end to end (fake transport) ----------
describe("HttpResearchProvider", () => {
  const site: Record<string, Route> = {
    "http://shreesagar.example.in/": { status: 301, headers: { location: HOME } },
    [HOME]: {
      body: fixture("home-jsonld.html"),
      headers: { "last-modified": "Wed, 21 Oct 2025 07:28:00 GMT", server: "nginx" },
      timeMs: 120,
    },
    "https://shreesagar.example.in/robots.txt": { body: "User-agent: *\nDisallow: /about-us/" },
    "https://shreesagar.example.in/contact": { body: fixture("contact-microdata.html") },
  };

  it("researches homepage + allowed contact pages and returns facts with provenance and signals", async () => {
    const { p, calls } = provider(site);
    const r = await p.research({
      businessId: "b1",
      name: "Shree Sagar",
      website: "shreesagar.example.in",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value;
    expect(v.status).toBe("ok");
    expect(v.signals).toMatchObject({
      https: true,
      redirectedToHttps: true,
      redirectCount: 1,
      httpStatus: 200,
      hasViewport: true,
      hasTitle: true,
      hasMetaDescription: true,
      responseTimeMs: 120,
      lastModified: "2025-10-21T07:28:00.000Z",
      copyrightYear: 2025,
      generator: "WordPress 6.5.2",
      robotsTxt: "found",
      pagesFetched: 2,
      server: "nginx",
    });
    expect(v.signals.tech).toContain("WordPress");
    expect(calls.map((c) => c.url)).not.toContain("https://shreesagar.example.in/about-us/");
    expect(v.requests).toBe(calls.length);
    const contactFacts = v.facts.filter((f) => f.sourceUrl.endsWith("/contact"));
    expect(contactFacts.length).toBeGreaterThan(0);
    for (const f of v.facts) {
      expect(f.collectedAt).toEqual(NOW);
      expect(f.verificationStatus).toBe("unverified");
      expect(f.usageRestriction).toMatch(/robots\.txt/);
      expect(f.confidence).toBeGreaterThan(0);
      expect(f.confidence).toBeLessThanOrEqual(1);
    }
    expect(v.summary).toMatch(/HTTPS after redirect/);
    expect(v.summary).not.toMatch(/score/i);
  });

  it("respects maxPages", async () => {
    const { p, calls } = provider(
      { ...site, "https://shreesagar.example.in/robots.txt": { body: "" } },
      { maxPages: 1 },
    );
    await p.research({ businessId: "b1", name: "x", website: HOME });
    expect(calls.filter((c) => !c.url.endsWith("robots.txt"))).toHaveLength(1);
  });

  it("homepage only when Crawl-delay exceeds the cap", async () => {
    const { p, calls } = provider({
      ...site,
      "https://shreesagar.example.in/robots.txt": { body: "User-agent: *\nCrawl-delay: 120" },
    });
    const r = await p.research({ businessId: "b1", name: "x", website: HOME });
    expect(r.ok && r.value.signals.crawlDelaySeconds).toBe(120);
    expect(calls.map((c) => c.url)).toEqual(["https://shreesagar.example.in/robots.txt", HOME]);
  });

  it("reports no website, social-only, invalid, broken, blocked and SSRF without fetching unsafe hosts", async () => {
    const { p, calls } = provider({
      "https://down.example.in/": { status: 500 },
      "https://closed.example.in/robots.txt": { body: "User-agent: *\nDisallow: /" },
      "https://pdf.example.in/": {
        body: "%PDF-1.4",
        headers: { "content-type": "application/pdf" },
      },
    });
    const st = async (website: string | null) => {
      const r = await p.research({ businessId: "x", name: "x", website });
      if (!r.ok) throw new Error(r.error);
      return r.value;
    };
    expect((await st(null)).status).toBe("no_website");
    expect(await st("https://facebook.com/somebiz")).toMatchObject({
      status: "no_website",
      signals: { socialProfileOnly: "facebook.com" },
    });
    expect(await st("not a url at all")).toMatchObject({
      status: "broken",
      signals: { broken: "invalid_url" },
    });
    expect(await st("https://down.example.in/")).toMatchObject({
      status: "broken",
      signals: { broken: "http_5xx", httpStatus: 500 },
    });
    expect(await st("https://closed.example.in/")).toMatchObject({
      status: "blocked",
      signals: { blockedByRobots: true },
    });
    expect(await st("https://pdf.example.in/")).toMatchObject({
      status: "broken",
      signals: { broken: "not_html" },
    });
    const before = calls.length;
    expect(await st("http://192.168.0.10/")).toMatchObject({
      status: "broken",
      signals: { broken: "ssrf_blocked" },
    });
    expect(calls.length).toBe(before); // no request at all
  });

  it("refuses the loopback test flag in production", () => {
    expect(MIN_HOST_DELAY_MS).toBe(2000);
    expect(
      () =>
        new HttpResearchProvider({
          userAgent: "x",
          allowLoopbackForTests: true,
          appEnv: "production",
        }),
    ).toThrow(/production/);
  });

  it("applies the 2 s delay floor between requests to one host even if configured lower", async () => {
    const { p, calls } = provider(site, { hostDelayMs: 10 });
    await p.research({ businessId: "b1", name: "x", website: HOME });
    for (let i = 1; i < calls.length; i++)
      expect(calls[i]!.at - calls[i - 1]!.at).toBeGreaterThanOrEqual(2000);
  });
});

describe("MockResearchProvider and factory", () => {
  it("is deterministic, labelled MOCK and has a failure hook", async () => {
    const m = new MockResearchProvider(() => NOW);
    const a = await m.research({
      businessId: "1",
      name: "Cafe",
      website: "https://example.com/mock-cafe-1",
    });
    const b = await m.research({
      businessId: "1",
      name: "Cafe",
      website: "https://example.com/mock-cafe-1",
    });
    expect(a).toEqual(b);
    expect(a.ok && a.value.facts.every((f) => f.sourceType === "mock")).toBe(true);
    expect(a.ok && a.value.summary).toMatch(/MOCK/);
    expect(
      (await m.research({ businessId: "2", name: "x", website: "https://example.com/broken" }))
        .ok && "broken",
    ).toBe("broken");
    m.failOnce.add("3");
    expect((await m.research({ businessId: "3", name: "x" })).ok).toBe(false);
    expect((await m.research({ businessId: "3", name: "x" })).ok).toBe(true);
  });
  it("resolves RESEARCH_PROVIDER and refuses mock in production", () => {
    expect(resolveResearchKind({})).toBe("http");
    expect(resolveResearchKind({ RESEARCH_PROVIDER: " MOCK " })).toBe("mock");
    expect(() => resolveResearchKind({ RESEARCH_PROVIDER: "firecrawl" })).toThrow(/http, mock/);
    expect(() => resolveResearchKind({ RESEARCH_PROVIDER: "mock", APP_ENV: "production" })).toThrow(
      /production/,
    );
    expect(() => createResearchProvider("mock", { APP_ENV: "production" })).toThrow(/production/);
    expect(researchKindFromProviderId("http-extractor")).toBe("http");
    expect(researchKindFromProviderId("nope")).toBeNull();
  });
  it("builds an identifying User-Agent with a contact", () => {
    expect(
      researchUserAgent({
        APP_URL: "https://kalpix.in",
        RESEARCH_USER_AGENT_CONTACT: "ops@kalpix.in",
      }),
    ).toBe("KalpixBot/0.1 (+https://kalpix.in; ops@kalpix.in)");
    expect(researchUserAgent({})).toMatch(/contact not set/);
  });
});
