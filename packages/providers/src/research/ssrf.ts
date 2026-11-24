import net from "node:net";

/**
 * SSRF guard for the website researcher. Website URLs come from third-party data (OSM tags), so
 * they are untrusted: only http/https on normal web ports, no credentials in the URL, and never
 * a private, loopback, link-local, CGNAT, multicast or reserved address. The IP check runs at
 * connect time too (see transport.ts), so DNS rebinding between check and connect is covered.
 */
export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

export interface UrlPolicy {
  /** Test-only: allow 127.0.0.1/::1 and any port (in-process test servers). Never in production. */
  allowLoopback?: boolean;
}

const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8000", "8443"]);

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, o) => acc * 256 + Number(o), 0);
}
function inV4(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split("/") as [string, string];
  const size = 2 ** (32 - Number(bitsStr));
  return Math.floor(ipv4ToInt(ip) / size) === Math.floor(ipv4ToInt(base) / size);
}

const V4_BLOCKED = [
  "0.0.0.0/8", // "this" network
  "10.0.0.0/8", // private
  "100.64.0.0/10", // CGNAT
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local (cloud metadata 169.254.169.254)
  "172.16.0.0/12", // private
  "192.0.0.0/24", // IETF protocol assignments
  "192.0.2.0/24", // TEST-NET-1
  "192.88.99.0/24", // 6to4 relay
  "192.168.0.0/16", // private
  "198.18.0.0/15", // benchmarking
  "198.51.100.0/24", // TEST-NET-2
  "203.0.113.0/24", // TEST-NET-3
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved + broadcast
];

/** Expands an IPv6 address to 8 groups of 16-bit numbers. */
function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  // embedded IPv4 tail (::ffff:1.2.3.4)
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = ipv4ToInt(v4[1]!);
    s = s.slice(0, -v4[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array(fill).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => parseInt(g, 16));
  return nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? nums : null;
}

export function isLoopbackIp(ip: string): boolean {
  if (net.isIPv4(ip)) return inV4(ip, "127.0.0.0/8");
  const g = expandV6(ip);
  if (!g) return false;
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff)
    return isLoopbackIp(`${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`);
  return false;
}

/** True for any address a public-website fetch must never reach. */
export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return V4_BLOCKED.some((c) => inV4(ip, c));
  if (!net.isIPv6(ip)) return true; // not an IP: refuse
  const g = expandV6(ip);
  if (!g) return true;
  const [a] = g as [number];
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the IPv4 part
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0))
    return isBlockedIp(`${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`);
  if (a === 0x64 && g[1] === 0xff9b) return true; // NAT64 64:ff9b::/96 can reach private v4
  if ((a & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((a & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((a & 0xff00) === 0xff00) return true; // multicast
  if (a === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (a === 0x2002) return true; // 6to4 can embed private v4
  return false;
}

export function isIpAllowed(ip: string, policy: UrlPolicy = {}): boolean {
  if (policy.allowLoopback && isLoopbackIp(ip)) return true;
  return !isBlockedIp(ip);
}

/** Bare hostname (IPv6 brackets removed). */
export function hostnameOf(u: URL): string {
  return u.hostname.replace(/^\[|\]$/g, "");
}

/**
 * Static checks on a URL (scheme, port, credentials, literal IPs, obviously-internal names).
 * Throws SsrfError. Hostnames are additionally checked after DNS resolution at connect time.
 */
export function assertUrlAllowed(raw: string | URL, policy: UrlPolicy = {}): URL {
  let u: URL;
  try {
    u = typeof raw === "string" ? new URL(raw) : raw;
  } catch {
    throw new SsrfError("Invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new SsrfError(`Scheme ${u.protocol} is not allowed`);
  if (u.username || u.password) throw new SsrfError("Credentials in URL are not allowed");
  const host = hostnameOf(u).toLowerCase();
  if (!host) throw new SsrfError("URL has no host");
  if (net.isIP(host)) {
    if (!isIpAllowed(host, policy)) throw new SsrfError(`Address ${host} is not public`);
  } else {
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      host.endsWith(".lan") ||
      host.endsWith(".home.arpa") ||
      !host.includes(".")
    )
      throw new SsrfError(`Host ${host} is not a public name`);
  }
  const loopbackTest = policy.allowLoopback && net.isIP(host) && isLoopbackIp(host);
  if (!loopbackTest && !ALLOWED_PORTS.has(u.port))
    throw new SsrfError(`Port ${u.port} is not allowed`);
  return u;
}
