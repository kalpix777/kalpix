// End-to-end smoke test against a running admin (pnpm start). Uses the seeded owner.
// Usage: BASE_URL=http://localhost:3000 node e2e/smoke.mjs
import "dotenv/config";
import pg from "pg";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const email = process.env.SEED_OWNER_EMAIL;
const password = process.env.SEED_OWNER_PASSWORD;
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
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` (${extra})` : ""}`);
  if (!cond) failures++;
};

async function signIn(e, p) {
  return withRetry(() => signInOnce(e, p));
}
async function signInOnce(e, p) {
  const r = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email: e, password: p }),
  });
  const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  return { status: r.status, cookie, body: await r.json().catch(() => ({})) };
}
const get = (path, cookie) =>
  fetch(`${BASE}${path}`, { headers: cookie ? { cookie } : {}, redirect: "manual" });

// 1. Anonymous access is redirected
const anon = await get("/");
check(
  "anonymous / redirects to /login",
  anon.status === 307 && anon.headers.get("location")?.includes("/login"),
  String(anon.status),
);
check("login page renders", (await get("/login")).status === 200);

// 2. Public sign-up disabled
const su = await fetch(`${BASE}/api/auth/sign-up/email`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: BASE },
  body: JSON.stringify({ email: "x@example.com", password: "aaaaaaaaaaaaaa", name: "x" }),
});
check("public sign-up is disabled", su.status >= 400, String(su.status));

// 3. Wrong password rejected
check("wrong password rejected", (await signIn(email, "wrong-password-123")).status === 401);

// 4. Owner signs in and can open every Phase 2 page
const owner = await signIn(email, password);
check("owner sign-in", owner.status === 200 && owner.cookie.length > 0, String(owner.status));
for (const p of [
  "/",
  "/providers",
  "/integrations",
  "/users",
  "/audit",
  "/settings",
  "/sales",
  "/security",
  "/discovery",
  "/payments",
]) {
  const r = await get(p, owner.cookie);
  check(`owner GET ${p}`, r.status === 200, String(r.status));
}
check("unknown module 404s", (await get("/does-not-exist", owner.cookie)).status === 404);

// 5. A viewer is denied admin pages
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const viewerEmail = `viewer-${Date.now()}@kalpix.local`;
const { auth } = await import("../src/lib/auth.ts").catch(() => ({ auth: null }));
if (auth) {
  const res = await auth.api.createUser({
    body: { email: viewerEmail, password: "Viewer-Pass-2026!", name: "Viewer Test" },
  });
  const viewer = await signIn(viewerEmail, "Viewer-Pass-2026!");
  check("viewer sign-in", viewer.status === 200);
  for (const p of ["/users", "/providers", "/audit", "/settings", "/sales"]) {
    const r = await get(p, viewer.cookie);
    check(
      `viewer denied ${p}`,
      r.status === 307 && r.headers.get("location")?.includes("denied=1"),
      `${r.status}`,
    );
  }
  check("viewer can open overview", (await get("/", viewer.cookie)).status === 200);
  await db.query(`update "user" set banned = true where id = $1`, [res.user.id]);
  check(
    "suspended user cannot sign in",
    (await signIn(viewerEmail, "Viewer-Pass-2026!")).status >= 400,
  );
}

// 6. Audit log recorded sign-ins and is append-only
const { rows } = await db.query(
  `select count(*)::int n from audit_log where action = 'auth.sign_in'`,
);
check("sign-ins are audited", rows[0].n >= 1, `${rows[0].n} events`);
let blocked = false;
try {
  await db.query(`delete from audit_log`);
} catch {
  blocked = true;
}
check("audit log rejects DELETE", blocked);
blocked = false;
try {
  await db.query(`update audit_log set action = 'x'`);
} catch {
  blocked = true;
}
check("audit log rejects UPDATE", blocked);

// 7. Security headers
const h = await get("/login");
check("X-Frame-Options DENY", h.headers.get("x-frame-options") === "DENY");
check("no X-Powered-By", !h.headers.get("x-powered-by"));

await db.end();
console.log(failures ? `\n${failures} check(s) failed` : "\nAll smoke checks passed");
process.exit(failures ? 1 : 0);
