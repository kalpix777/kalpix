// Verifies TOTP MFA end to end for a throwaway admin user, then cleans up its sessions.
import "dotenv/config";
import crypto from "node:crypto";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Sign-in is rate limited by design (Better Auth: 3 attempts / 10 s); retry politely on 429.
async function withRetry(fn) {
  for (let i = 0; i < 6; i++) {
    const r = await fn();
    if (r.status !== 429) return r;
    await sleep(4000);
  }
  return fn();
}
const check = (n, c, x = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? ` (${x})` : ""}`);
  if (!c) failures++;
};
const post = (path, body, cookie) => withRetry(() => postOnce(path, body, cookie));
const postOnce = async (path, body, cookie) => {
  const r = await fetch(`${BASE}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  const set = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  return { status: r.status, set, json: await r.json().catch(() => ({})) };
};
function base32Decode(s) {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of s.replace(/=+$/, "").toUpperCase())
    bits += a.indexOf(ch).toString(2).padStart(5, "0");
  return Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
}
function totp(secret, step = 30) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / step)));
  const h = crypto.createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0");
}

const { auth } = await import("../src/lib/auth.ts");
const email = `mfa-${Date.now()}@kalpix.local`,
  password = "Mfa-Test-Pass-2026!";
await auth.api.createUser({ body: { email, password, name: "MFA Test" } });
const s1 = await post("/sign-in/email", { email, password });
check("sign-in before MFA", s1.status === 200);
const en = await post("/two-factor/enable", { password }, s1.set);
check(
  "enable returns TOTP URI and backup codes",
  en.status === 200 && en.json.totpURI && en.json.backupCodes?.length > 0,
  String(en.status),
);
const secret = new URL(en.json.totpURI).searchParams.get("secret");
const v = await post("/two-factor/verify-totp", { code: totp(secret) }, s1.set);
check("TOTP verification turns MFA on", v.status === 200, String(v.status));
const s2 = await post("/sign-in/email", { email, password });
check(
  "next sign-in requires second factor",
  s2.status === 200 && s2.json.twoFactorRedirect === true,
);
const bad = await post("/two-factor/verify-totp", { code: "000000" }, s2.set);
check("wrong TOTP code rejected", bad.status >= 400, String(bad.status));
const good = await post("/two-factor/verify-totp", { code: totp(secret) }, s2.set);
check(
  "correct TOTP completes sign-in",
  good.status === 200 && good.set.includes("session_token"),
  String(good.status),
);
console.log(failures ? `\n${failures} failed` : "\nMFA checks passed");
process.exit(failures ? 1 : 0);
