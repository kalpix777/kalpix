import * as cheerio from "cheerio";
import type { ResearchFact, ResearchField, ResearchSourceType } from "@kalpix/core";
import { FACT_NORMALIZED_MAX, FACT_VALUE_MAX } from "@kalpix/core";
import { normalizePhone } from "../osm/normalize";

/** A fact before the provider stamps collectedAt / verificationStatus / usageRestriction. */
export type ExtractedFact = Omit<
  ResearchFact,
  "collectedAt" | "verificationStatus" | "usageRestriction"
>;

/**
 * Extraction-method confidence (how often this method yields a correct value), NOT verification.
 * Structured data the owner published > explicit tel:/mailto: links > page meta > free-text regex.
 */
export const CONFIDENCE: Record<string, number> = {
  jsonld: 0.8,
  microdata: 0.75,
  link: 0.7,
  meta: 0.6,
  text: 0.5,
};

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

export function makeFact(
  field: ResearchField,
  value: string,
  normalizedValue: string,
  sourceType: ResearchSourceType,
  confidence: number,
  sourceUrl: string,
): ExtractedFact {
  return {
    field,
    value: cap(squash(value), FACT_VALUE_MAX),
    normalizedValue: cap(normalizedValue, FACT_NORMALIZED_MAX),
    sourceType,
    confidence,
    sourceUrl,
  };
}

// ---------------- normalisers ----------------

/** E.164 for Indian numbers (national number 10 digits, not starting 0/1); other +CC kept. */
export function normalizeIndianPhone(raw: string, opts: { strict?: boolean } = {}): string | null {
  const cleaned = raw.replace(/^tel:/i, "").replace(/%20/g, " ").split(/[,;/]/)[0]?.trim() ?? "";
  if (!cleaned) return null;
  let n = normalizePhone(cleaned);
  if (!n) return null;
  if (/^\+910\d{10}$/.test(n)) n = `+91${n.slice(4)}`; // "+91 (0831) 2345678"
  if (/^\+91[2-9]\d{9}$/.test(n)) return n;
  if (!opts.strict && /^\+(?!91)[1-9]\d{7,14}$/.test(n) && cleaned.trim().startsWith("+")) return n;
  return null;
}

export function normalizeEmailValue(raw: string): string | null {
  const v = raw
    .replace(/^mailto:/i, "")
    .split("?")[0]!
    .trim()
    .toLowerCase();
  let decoded = v;
  try {
    decoded = decodeURIComponent(v);
  } catch {
    /* keep */
  }
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$/.test(decoded)) return null;
  if (/\.(png|jpe?g|gif|webp|svg|css|js)$/.test(decoded)) return null;
  const [local, domain] = decoded.split("@") as [string, string];
  if (
    /(^|\.)(example\.(com|org|net)|domain\.com|email\.com|yourdomain\.com|sentry\.io|wixpress\.com|sentry-next\.wixpress\.com)$/.test(
      domain,
    )
  )
    return null;
  if (["you", "your", "yourname", "name", "user", "username", "email"].includes(local)) return null;
  return decoded;
}

/** Undoes simple obfuscation: "info [at] shop [dot] in", "info(at)shop(dot)in". */
export function deobfuscateEmails(text: string): string {
  return text
    .replace(/\s*[[({<]\s*at\s*[\])}>]\s*/gi, "@")
    .replace(/\s*[[({<]\s*dot\s*[\])}>]\s*/gi, ".")
    .replace(/\b([a-z0-9._%+-]+)\s+at\s+([a-z0-9-]+)\s+dot\s+([a-z]{2,24})\b/gi, "$1@$2.$3");
}

export function normalizeHours(raw: string): string {
  return squash(raw.toLowerCase())
    .replace(/\s*;\s*/g, "; ")
    .replace(/\s*,\s*/g, ",")
    .replace(/\s*-\s*/g, "-")
    .replace(/;\s*$/, "");
}

export function canonicalUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}${u.search}`;
  } catch {
    return null;
  }
}

// ---------------- social ----------------

export type SocialField =
  "social_facebook" | "social_instagram" | "social_x" | "social_linkedin" | "social_youtube";

export type SocialMatch =
  { kind: "social"; field: SocialField; url: string } | { kind: "whatsapp"; phone: string };

const SKIP: Record<string, string[]> = {
  facebook: [
    "sharer",
    "sharer.php",
    "share",
    "share.php",
    "dialog",
    "plugins",
    "tr",
    "login",
    "login.php",
    "l.php",
    "hashtag",
    "events",
    "watch",
    "photo.php",
    "photos",
    "story.php",
  ],
  instagram: ["p", "reel", "reels", "explore", "accounts", "stories", "tv"],
  x: ["intent", "share", "home", "i", "search", "hashtag", "login", "signup"],
};

function whatsappPhone(digitsRaw: string | null | undefined): string | null {
  const d = (digitsRaw ?? "").replace(/\D/g, "");
  if (!d) return null;
  if (d.length === 10 && /^[6-9]/.test(d)) return `+91${d}`;
  if (d.length >= 8 && d.length <= 15) return `+${d}`;
  return null;
}

/** Classifies a link as a social profile or a WhatsApp number; null otherwise. */
export function classifySocial(href: string): SocialMatch | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol === "whatsapp:") {
    const p = whatsappPhone(u.searchParams.get("phone"));
    return p ? { kind: "whatsapp", phone: p } : null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile|web|in|business)\./, "");
  const segs = u.pathname.split("/").filter(Boolean);
  const first = (segs[0] ?? "").toLowerCase();
  if (host === "wa.me") {
    const p = whatsappPhone(segs[0]);
    return p ? { kind: "whatsapp", phone: p } : null;
  }
  if (host === "api.whatsapp.com" || host === "whatsapp.com") {
    const p = whatsappPhone(u.searchParams.get("phone"));
    return p ? { kind: "whatsapp", phone: p } : null;
  }
  if (host === "facebook.com" || host === "fb.com") {
    if (!first || SKIP.facebook!.includes(first)) return null;
    if (first === "profile.php") {
      const id = u.searchParams.get("id");
      return id && /^\d+$/.test(id)
        ? {
            kind: "social",
            field: "social_facebook",
            url: `https://facebook.com/profile.php?id=${id}`,
          }
        : null;
    }
    const path =
      first === "pages" || first === "people" || first === "groups" ? segs.slice(0, 3) : [segs[0]!];
    return {
      kind: "social",
      field: "social_facebook",
      url: `https://facebook.com/${path.join("/").toLowerCase()}`,
    };
  }
  if (host === "instagram.com") {
    if (!first || SKIP.instagram!.includes(first)) return null;
    return { kind: "social", field: "social_instagram", url: `https://instagram.com/${first}` };
  }
  if (host === "twitter.com" || host === "x.com") {
    if (!first || SKIP.x!.includes(first)) return null;
    return { kind: "social", field: "social_x", url: `https://x.com/${first}` };
  }
  if (host === "linkedin.com") {
    if (!["company", "in", "school", "showcase"].includes(first) || !segs[1]) return null;
    return {
      kind: "social",
      field: "social_linkedin",
      url: `https://linkedin.com/${first}/${segs[1]!.toLowerCase()}`,
    };
  }
  if (host === "youtube.com") {
    if (first.startsWith("@"))
      return { kind: "social", field: "social_youtube", url: `https://youtube.com/${first}` };
    if (["channel", "c", "user"].includes(first) && segs[1])
      return {
        kind: "social",
        field: "social_youtube",
        // channel ids are case-sensitive; custom names are not
        url: `https://youtube.com/${first}/${first === "channel" ? segs[1] : segs[1]!.toLowerCase()}`,
      };
    return null;
  }
  return null;
}

/** Listed "websites" that are really profiles on another platform, not an own website. */
export function socialOrMarketplaceHost(raw: string): string | null {
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/^(www|m)\./, "");
    const known = [
      "facebook.com",
      "fb.com",
      "instagram.com",
      "twitter.com",
      "x.com",
      "linkedin.com",
      "youtube.com",
      "wa.me",
      "justdial.com",
      "indiamart.com",
      "sulekha.com",
      "zomato.com",
      "swiggy.com",
      "practo.com",
      "booking.com",
      "tripadvisor.com",
      "tripadvisor.in",
      "google.com",
      "g.page",
      "maps.app.goo.gl",
      "linktr.ee",
    ];
    return known.find((k) => host === k || host.endsWith(`.${k}`)) ?? null;
  } catch {
    return null;
  }
}

function addSocialFact(
  out: ExtractedFact[],
  m: SocialMatch,
  sourceType: ResearchSourceType,
  confidence: number,
  sourceUrl: string,
  original: string,
) {
  if (m.kind === "whatsapp")
    out.push(makeFact("whatsapp", m.phone, m.phone, sourceType, confidence, sourceUrl));
  else out.push(makeFact(m.field, original, m.url, sourceType, confidence, sourceUrl));
}

// ---------------- JSON-LD ----------------

const BUSINESS_TYPES = new Set([
  "organization",
  "localbusiness",
  "corporation",
  "ngo",
  "educationalorganization",
  "school",
  "collegeoruniversity",
  "medicalorganization",
  "hospital",
  "medicalclinic",
  "dentist",
  "physician",
  "pharmacy",
  "restaurant",
  "foodestablishment",
  "cafeorcoffeeshop",
  "bakery",
  "barorpub",
  "fastfoodrestaurant",
  "hotel",
  "lodgingbusiness",
  "motel",
  "resort",
  "hostel",
  "store",
  "autodealer",
  "autorepair",
  "automotivebusiness",
  "realestateagent",
  "professionalservice",
  "legalservice",
  "attorney",
  "accountingservice",
  "beautysalon",
  "dayspa",
  "gym",
  "exercisegym",
  "travelagency",
  "insuranceagency",
  "financialservice",
  "homeandconstructionbusiness",
  "healthandbeautybusiness",
  "sportsactivitylocation",
  "entertainmentbusiness",
]);
const BUSINESS_SUFFIX =
  /(business|store|shop|organization|restaurant|service|agency|clinic|hospital|hotel|dealer|repair|school|center|centre)$/i;

function typesOf(node: Record<string, unknown>): string[] {
  const t = node["@type"];
  const arr = Array.isArray(t) ? t : t ? [t] : [];
  return arr
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.replace(/^https?:\/\/schema\.org\//i, ""));
}

export function isBusinessType(types: string[]): boolean {
  return types.some((t) => BUSINESS_TYPES.has(t.toLowerCase()) || BUSINESS_SUFFIX.test(t));
}

function strings(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  if (typeof v === "number") return [String(v)];
  if (typeof v === "object" && typeof (v as Record<string, unknown>)["@id"] === "string")
    return [String((v as Record<string, unknown>)["@id"])];
  return [];
}

const DAY: Record<string, string> = {
  monday: "Mo",
  tuesday: "Tu",
  wednesday: "We",
  thursday: "Th",
  friday: "Fr",
  saturday: "Sa",
  sunday: "Su",
};
const DAY_ORDER = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/** openingHoursSpecification -> OSM-style "Mo-Sa 09:00-18:00" (consecutive equal days merged). */
export function hoursFromSpecification(spec: unknown): string | null {
  const items = (Array.isArray(spec) ? spec : [spec]).filter(
    (x): x is Record<string, unknown> => !!x && typeof x === "object",
  );
  const perDay = new Map<string, string[]>();
  for (const it of items) {
    const opens = strings(it.opens)[0]?.slice(0, 5);
    const closes = strings(it.closes)[0]?.slice(0, 5);
    if (!opens || !closes) continue;
    for (const d of strings(it.dayOfWeek)) {
      const key = DAY[d.replace(/^https?:\/\/schema\.org\//i, "").toLowerCase()];
      if (!key) continue;
      perDay.set(key, [...(perDay.get(key) ?? []), `${opens}-${closes}`]);
    }
  }
  if (!perDay.size) return null;
  const parts: string[] = [];
  let i = 0;
  while (i < DAY_ORDER.length) {
    const d = DAY_ORDER[i]!;
    const h = perDay.get(d)?.join(",");
    if (!h) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < DAY_ORDER.length && perDay.get(DAY_ORDER[j + 1]!)?.join(",") === h) j++;
    parts.push(`${j > i ? `${d}-${DAY_ORDER[j]}` : d} ${h}`);
    i = j + 1;
  }
  return parts.join("; ");
}

function addressText(a: unknown): { text: string; postcode?: string } | null {
  if (typeof a === "string") {
    const pin = a.match(/\b(\d{3}\s?\d{3})\b/);
    return { text: a, postcode: pin?.[1]?.replace(/\s/g, "") };
  }
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  const country =
    typeof o.addressCountry === "object" && o.addressCountry
      ? strings((o.addressCountry as Record<string, unknown>).name)[0]
      : strings(o.addressCountry)[0];
  const parts = [
    ...strings(o.streetAddress),
    ...strings(o.addressLocality),
    ...strings(o.addressRegion),
    ...strings(o.postalCode),
    ...(country ? [country] : []),
  ];
  if (!parts.length) return null;
  return { text: parts.join(", "), postcode: strings(o.postalCode)[0]?.replace(/\s/g, "") };
}

function businessNodeFacts(
  node: Record<string, unknown>,
  sourceType: "jsonld" | "microdata",
  sourceUrl: string,
  out: ExtractedFact[],
) {
  const c = CONFIDENCE[sourceType]!;
  for (const name of strings(node.name).slice(0, 1))
    out.push(makeFact("name", name, squash(name.toLowerCase()), sourceType, c, sourceUrl));
  for (const t of strings(node.telephone)) {
    const p = normalizeIndianPhone(t);
    if (p) out.push(makeFact("phone", t, p, sourceType, c, sourceUrl));
  }
  for (const e of strings(node.email)) {
    const n = normalizeEmailValue(e);
    if (n) out.push(makeFact("email", n, n, sourceType, c, sourceUrl));
  }
  const addrs = Array.isArray(node.address) ? node.address : node.address ? [node.address] : [];
  for (const a of addrs) {
    const t = addressText(a);
    if (!t) continue;
    out.push(makeFact("address", t.text, squash(t.text.toLowerCase()), sourceType, c, sourceUrl));
    if (t.postcode)
      out.push(makeFact("postcode", t.postcode, t.postcode, sourceType, c, sourceUrl));
  }
  const geo = node.geo as Record<string, unknown> | undefined;
  if (geo && typeof geo === "object") {
    const lat = Number(strings(geo.latitude)[0]);
    const lon = Number(strings(geo.longitude)[0]);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180)
      out.push(
        makeFact(
          "geo",
          `${lat},${lon}`,
          `${lat.toFixed(5)},${lon.toFixed(5)}`,
          sourceType,
          c,
          sourceUrl,
        ),
      );
  }
  const oh = strings(node.openingHours);
  if (oh.length) {
    const v = oh.join("; ");
    out.push(makeFact("opening_hours", v, normalizeHours(v), sourceType, c, sourceUrl));
  }
  const spec = hoursFromSpecification(node.openingHoursSpecification);
  if (spec)
    out.push(makeFact("opening_hours", spec, normalizeHours(spec), sourceType, c, sourceUrl));
  for (const pr of strings(node.priceRange).slice(0, 1))
    out.push(makeFact("price_range", pr, pr.toLowerCase(), sourceType, c, sourceUrl));
  for (const s of strings(node.sameAs)) {
    const m = classifySocial(s);
    if (m) addSocialFact(out, m, sourceType, c, sourceUrl, s);
    else {
      const cu = canonicalUrl(s);
      if (cu) out.push(makeFact("same_as", s, cu, sourceType, c, sourceUrl));
    }
  }
  for (const u of strings(node.url).slice(0, 1)) {
    const cu = canonicalUrl(u);
    if (cu) out.push(makeFact("website", u, cu, sourceType, c, sourceUrl));
  }
}

/** Parses JSON-LD blocks; malformed blocks are skipped (counted in `errors`). */
export function extractJsonLd(
  $: cheerio.CheerioAPI,
  sourceUrl: string,
): { facts: ExtractedFact[]; businessNodes: number; errors: number } {
  const facts: ExtractedFact[] = [];
  let businessNodes = 0;
  let errors = 0;
  const visit = (v: unknown, depth: number) => {
    if (depth > 6 || v == null || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach((x) => visit(x, depth + 1));
    const node = v as Record<string, unknown>;
    if (isBusinessType(typesOf(node))) {
      businessNodes++;
      businessNodeFacts(node, "jsonld", sourceUrl, facts);
    }
    for (const [k, child] of Object.entries(node))
      if (k !== "address" && k !== "geo" && typeof child === "object") visit(child, depth + 1);
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el)
      .text()
      .trim()
      .replace(/^<!--|-->$/g, "");
    if (!raw) return;
    try {
      visit(JSON.parse(raw), 0);
    } catch {
      // common real-world defect: raw newlines inside strings
      try {
        visit(JSON.parse(raw.replace(/[\r\n\t]+/g, " ")), 0);
      } catch {
        errors++;
      }
    }
  });
  return { facts, businessNodes, errors };
}

// ---------------- microdata ----------------

export function extractMicrodata($: cheerio.CheerioAPI, sourceUrl: string): ExtractedFact[] {
  const out: ExtractedFact[] = [];
  $("[itemscope][itemtype]").each((_, el) => {
    const type = ($(el).attr("itemtype") ?? "").split(/\s+/)[0]!.split("/").pop() ?? "";
    if (!isBusinessType([type])) return;
    // properties that belong to this scope (not to a nested business scope)
    const own = (prop: string) =>
      $(el)
        .find(`[itemprop~="${prop}"]`)
        .filter((__, p) => {
          const scope = $(p).parent().closest("[itemscope]");
          return scope.length === 0 || scope[0] === el || $(scope).attr("itemprop") === "address";
        });
    const valueOf = (p: ReturnType<typeof $>) =>
      (
        p.attr("content") ??
        p.attr("datetime") ??
        (p.is("a") ? p.attr("href") : undefined) ??
        p.text()
      )?.trim() ?? "";
    const node: Record<string, unknown> = {};
    const name = own("name").first();
    if (name.length && !name.closest('[itemprop="address"]').length) node.name = valueOf(name);
    node.telephone = own("telephone")
      .map((__, p) => valueOf($(p)))
      .get();
    node.email = own("email")
      .map((__, p) => valueOf($(p)))
      .get();
    node.openingHours = own("openingHours")
      .map((__, p) => valueOf($(p)))
      .get();
    node.priceRange = own("priceRange")
      .map((__, p) => valueOf($(p)))
      .get();
    const addr = $(el).find('[itemprop="address"]').first();
    if (addr.length) {
      if (addr.attr("itemscope") !== undefined) {
        const a: Record<string, string> = {};
        for (const k of [
          "streetAddress",
          "addressLocality",
          "addressRegion",
          "postalCode",
          "addressCountry",
        ]) {
          const p = addr.find(`[itemprop="${k}"]`).first();
          if (p.length) a[k] = valueOf(p);
        }
        node.address = a;
      } else node.address = valueOf(addr);
    }
    businessNodeFacts(node, "microdata", sourceUrl, out);
  });
  return out;
}

// ---------------- page ----------------

export interface ExtractedLink {
  url: string;
  text: string;
}

export interface PageExtraction {
  facts: ExtractedFact[];
  links: ExtractedLink[];
  title?: string;
  metaDescription?: string;
  hasViewport: boolean;
  generator?: string;
  copyrightYear?: number;
  jsonLdBlocks: number;
  jsonLdErrors: number;
}

const PHONE_TEXT =
  /(?<![\d+])(?:\+\s?91[\s.-]?|0091[\s.-]?|0)?(?:\(?\d{2,5}\)?[\s.-]?)?\d{3,5}[\s.-]?\d{3,5}(?!\d)/g;
const EMAIL_TEXT = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi;

/** Indian phone numbers in free text. Strict: only +91 numbers that normalise unambiguously. */
export function findPhonesInText(text: string): { raw: string; e164: string }[] {
  const out: { raw: string; e164: string }[] = [];
  for (const m of text.matchAll(PHONE_TEXT)) {
    const raw = m[0].trim();
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 14) continue;
    const prefixed = /^(\+|0)/.test(raw);
    // bare 10 digits only when it is a mobile (6-9); landlines need their 0/+91 prefix
    if (!prefixed && !(digits.length === 10 && /^[6-9]/.test(digits))) continue;
    const e164 = normalizeIndianPhone(raw, { strict: true });
    if (e164) out.push({ raw, e164 });
  }
  return out;
}

export function findEmailsInText(text: string): string[] {
  const out = new Set<string>();
  for (const m of deobfuscateEmails(text).matchAll(EMAIL_TEXT)) {
    const n = normalizeEmailValue(m[0]);
    if (n) out.add(n);
  }
  return [...out];
}

export function findCopyrightYear(text: string, now = new Date()): number | undefined {
  const max = now.getUTCFullYear() + 1;
  let best: number | undefined;
  for (const m of text.matchAll(/(?:©|\(c\)|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/gi)) {
    const y = Number(m[1]);
    if (y >= 1995 && y <= max && (!best || y > best)) best = y;
  }
  return best;
}

const SKIP_EXT =
  /\.(pdf|jpe?g|png|gif|webp|svg|zip|rar|docx?|xlsx?|pptx?|mp4|mp3|avi|mov|css|js|xml|json|ico)$/i;

/** All facts, links and page-level signals for one HTML page. */
export function extractPage(
  html: string,
  pageUrl: string,
  opts: { isHome: boolean; now?: Date },
): PageExtraction {
  const $ = cheerio.load(html);
  const facts: ExtractedFact[] = [];
  const ld = extractJsonLd($, pageUrl);
  facts.push(...ld.facts);
  facts.push(...extractMicrodata($, pageUrl));

  const title = squash($("head title").first().text() || $("title").first().text()) || undefined;
  const metaDescription =
    squash($('meta[name="description" i]').attr("content") ?? "") || undefined;
  const hasViewport = $('meta[name="viewport" i]').length > 0;
  const generator = squash($('meta[name="generator" i]').attr("content") ?? "") || undefined;
  if (opts.isHome) {
    const m = CONFIDENCE.meta!;
    if (title) facts.push(makeFact("page_title", title, title.toLowerCase(), "meta", m, pageUrl));
    if (metaDescription)
      facts.push(
        makeFact(
          "meta_description",
          metaDescription,
          metaDescription.toLowerCase(),
          "meta",
          m,
          pageUrl,
        ),
      );
    for (const [prop, field] of [
      ["og:title", "og_title"],
      ["og:description", "og_description"],
      ["og:site_name", "og_site_name"],
    ] as const) {
      const v = squash($(`meta[property="${prop}"]`).attr("content") ?? "");
      if (v) facts.push(makeFact(field, v, v.toLowerCase(), "meta", m, pageUrl));
    }
  }

  // links: tel:, mailto:, social, WhatsApp, same-site navigation
  const links: ExtractedLink[] = [];
  const lc = CONFIDENCE.link!;
  $("a[href]").each((_, a) => {
    const href = ($(a).attr("href") ?? "").trim();
    if (!href) return;
    if (/^tel:/i.test(href)) {
      const p = normalizeIndianPhone(href);
      if (p) facts.push(makeFact("phone", href.replace(/^tel:/i, ""), p, "html", lc, pageUrl));
      return;
    }
    if (/^mailto:/i.test(href)) {
      const e = normalizeEmailValue(href);
      if (e) facts.push(makeFact("email", e, e, "html", lc, pageUrl));
      return;
    }
    let abs: URL;
    try {
      abs = new URL(href, pageUrl);
    } catch {
      return;
    }
    const social = classifySocial(abs.toString());
    if (social) {
      addSocialFact(facts, social, "html", lc, pageUrl, abs.toString());
      return;
    }
    if (abs.protocol !== "http:" && abs.protocol !== "https:") return;
    abs.hash = "";
    if (SKIP_EXT.test(abs.pathname)) return;
    links.push({ url: abs.toString(), text: squash($(a).text()).slice(0, 100) });
  });

  // free text (scripts/styles removed)
  $("script, style, noscript, template").remove();
  const text = $("body").length ? $("body").text() : $.root().text();
  const tc = CONFIDENCE.text!;
  for (const p of findPhonesInText(text))
    facts.push(makeFact("phone", p.raw, p.e164, "html", tc, pageUrl));
  for (const e of findEmailsInText(text)) facts.push(makeFact("email", e, e, "html", tc, pageUrl));

  return {
    facts: dedupeFacts(facts),
    links,
    title,
    metaDescription,
    hasViewport,
    generator,
    copyrightYear: findCopyrightYear(text, opts.now),
    jsonLdBlocks: ld.businessNodes,
    jsonLdErrors: ld.errors,
  };
}

/** One fact per (field, normalizedValue, sourceUrl): the highest-confidence extraction wins. */
export function dedupeFacts<T extends ExtractedFact>(facts: T[]): T[] {
  const best = new Map<string, T>();
  for (const f of facts) {
    const k = `${f.field}\u0000${f.normalizedValue}\u0000${f.sourceUrl}`;
    const prev = best.get(k);
    if (!prev || f.confidence > prev.confidence) best.set(k, f);
  }
  return [...best.values()];
}

const KEYWORDS =
  /contact|about|reach|location|find-?us|enquir|inquir|get-?in-?touch|visit|address|branches/i;

const siteKey = (h: string) => h.toLowerCase().replace(/^www\./, "");

/** Same-site pages likely to carry contact details, best first (homepage excluded). */
export function candidatePages(links: ExtractedLink[], homeUrl: string, limit: number): string[] {
  const home = new URL(homeUrl);
  const seen = new Set([home.toString().replace(/\/$/, "")]);
  const scored: { url: string; score: number; i: number }[] = [];
  links.forEach((l, i) => {
    let u: URL;
    try {
      u = new URL(l.url);
    } catch {
      return;
    }
    if (siteKey(u.hostname) !== siteKey(home.hostname) || u.port !== home.port) return;
    if (u.protocol !== home.protocol && u.protocol !== "https:") return;
    const key = u.toString().replace(/\/$/, "");
    if (seen.has(key)) return;
    seen.add(key);
    const hay = `${u.pathname} ${l.text}`;
    const score = KEYWORDS.test(u.pathname) ? 2 : KEYWORDS.test(l.text) ? 1 : 0;
    if (score > 0 && hay.length < 400) scored.push({ url: u.toString(), score, i });
  });
  return scored
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, Math.max(0, limit))
    .map((s) => s.url);
}
