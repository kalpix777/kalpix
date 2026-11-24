/**
 * Technology hints from HTML, headers and <meta name="generator">. Hints only: a match means the
 * marker is present, not that the site is fully built on that platform.
 */
const RULES: { name: string; html?: RegExp; header?: [string, RegExp]; generator?: RegExp }[] = [
  { name: "WordPress", html: /\/wp-content\/|\/wp-includes\//i, generator: /wordpress/i },
  { name: "WooCommerce", html: /woocommerce/i, generator: /woocommerce/i },
  {
    name: "Wix",
    html: /static\.wixstatic\.com|static\.parastorage\.com/i,
    header: ["x-wix-request-id", /./],
    generator: /wix\.com/i,
  },
  { name: "Shopify", html: /cdn\.shopify\.com|Shopify\.theme/i, header: ["x-shopid", /./] },
  { name: "Blogger", html: /\.blogspot\.com|blogger\.com\/static/i, generator: /blogger/i },
  { name: "Squarespace", html: /static1\.squarespace\.com/i, generator: /squarespace/i },
  { name: "Webflow", html: /data-wf-page|assets\.website-files\.com/i, generator: /webflow/i },
  { name: "Joomla", html: /\/media\/jui\/|\/components\/com_/i, generator: /joomla/i },
  {
    name: "Drupal",
    html: /\/sites\/default\/files\//i,
    header: ["x-drupal-cache", /./],
    generator: /drupal/i,
  },
  { name: "GoDaddy Website Builder", html: /img1\.wsimg\.com/i, generator: /go ?daddy|starfield/i },
  {
    name: "Google Sites",
    html: /sites\.google\.com|ssl\.gstatic\.com\/atari/i,
    generator: /google sites/i,
  },
  { name: "Weebly", html: /editmysite\.com|weebly\.com/i, generator: /weebly/i },
  { name: "Zoho Sites", html: /zohocdn\.com|zohositescontent/i },
  { name: "Duda", html: /irp\.cdn-website\.com|dudaone/i },
  {
    name: "Next.js",
    html: /__NEXT_DATA__|\/_next\/static\//i,
    header: ["x-powered-by", /next\.js/i],
  },
  { name: "PHP", header: ["x-powered-by", /php/i] },
  { name: "ASP.NET", header: ["x-powered-by", /asp\.net/i] },
  { name: "Cloudflare", header: ["cf-ray", /./] },
];

export function detectTech(
  html: string,
  headers: Record<string, string>,
  generator?: string,
): string[] {
  const out = new Set<string>();
  for (const r of RULES) {
    if (r.html && r.html.test(html)) out.add(r.name);
    if (r.generator && generator && r.generator.test(generator)) out.add(r.name);
    if (r.header) {
      const v = headers[r.header[0]];
      if (v !== undefined && r.header[1].test(v)) out.add(r.name);
    }
  }
  return [...out].sort();
}

export function parseHttpDate(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}
