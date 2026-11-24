import type { BrokenKind } from "@kalpix/core";

/**
 * robots.txt parsing and matching per RFC 9309: groups by user-agent (our product token, else
 * "*"), Allow/Disallow with "*" and "$" wildcards, the longest matching rule wins and Allow wins a
 * tie. Crawl-delay (not in the RFC, widely used) is honoured too.
 */
export interface RobotsRule {
  allow: boolean;
  pattern: string;
}

export interface RobotsPolicy {
  rules: RobotsRule[];
  crawlDelaySeconds?: number;
  /** "found": parsed file; "missing": 4xx (allow all); "unavailable": 5xx/unreachable (deny all). */
  source: "found" | "missing" | "unavailable";
  /** Why robots.txt could not be read (5xx, timeout, DNS, TLS, SSRF block). */
  unavailable?: { kind: BrokenKind; detail: string };
}

interface Group {
  agents: string[];
  rules: RobotsRule[];
  crawlDelay?: number;
}

export function parseRobots(text: string, productToken: string): RobotsPolicy {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      if (key === "disallow" && value === "") continue; // empty Disallow = allow all
      current.rules.push({ allow: key === "allow", pattern: value });
    } else if (key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    }
  }
  const token = productToken.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && token.startsWith(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  const rules = chosen.flatMap((g) => g.rules);
  const delays = chosen.map((g) => g.crawlDelay).filter((d): d is number => d !== undefined);
  return {
    rules,
    crawlDelaySeconds: delays.length ? Math.max(...delays) : undefined,
    source: "found",
  };
}

export const ALLOW_ALL: RobotsPolicy = { rules: [], source: "missing" };
export const DENY_ALL: RobotsPolicy = {
  rules: [{ allow: false, pattern: "/" }],
  source: "unavailable",
};

function patternToRegex(p: string): RegExp {
  const anchored = p.endsWith("$");
  const body = (anchored ? p.slice(0, -1) : p)
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** Path + query of a URL, as robots rules see it. */
export function robotsPath(u: URL): string {
  return (u.pathname || "/") + (u.search || "");
}

export function isAllowedByRobots(policy: RobotsPolicy, pathAndQuery: string): boolean {
  let best: RobotsRule | null = null;
  for (const r of policy.rules) {
    if (!r.pattern) continue;
    let matches = false;
    try {
      matches = patternToRegex(r.pattern).test(pathAndQuery);
    } catch {
      matches = false;
    }
    if (!matches) continue;
    if (
      !best ||
      r.pattern.length > best.pattern.length ||
      (r.pattern.length === best.pattern.length && r.allow)
    )
      best = r;
  }
  return best ? best.allow : true;
}
