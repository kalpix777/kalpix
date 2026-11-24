// Phase 3 discovery end to end against a running admin (pnpm start) and a real PostgreSQL.
// Uses the MOCK provider only (no network): queues runs through the API, drains them with
// `pnpm worker:once`, then checks the pages, the CSV export and the audit trail.
// Usage: BASE_URL=http://localhost:3000 tsx e2e/discovery.mjs
import "dotenv/config";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import pg from "pg";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ownerEmail = process.env.SEED_OWNER_EMAIL;
const ownerPassword = process.env.SEED_OWNER_PASSWORD;
// The mock provider's default box (south,west,north,east): explicit bbox, so no geocoding.
const AREA = "15.84,74.49,15.88,74.53";
const CATEGORIES = ["garages", "restaurants"];
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

const signIn = (e, p) => withRetry(() => signInOnce(e, p));
async function signInOnce(e, p) {
  const r = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email: e, password: p }),
  });
  const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  return { status: r.status, cookie };
}
const get = (path, cookie) =>
  fetch(`${BASE}${path}`, { headers: cookie ? { cookie } : {}, redirect: "manual" });
async function startRun(cookie, body) {
  const r = await fetch(`${BASE}/api/discovery/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, cookie },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
function drainWorker() {
  // Same command an operator runs; DISCOVERY_PROVIDER=mock keeps it offline.
  return execFileSync("pnpm", ["-F", "@kalpix/worker", "once"], {
    env: { ...process.env, DISCOVERY_PROVIDER: "mock" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
const text = (html) => html.replace(/<!-- -->/g, "");

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const mockCount = async () =>
  (await db.query(`select count(*)::int n from business where provider = 'mock-discovery'`)).rows[0]
    .n;
const auditCount = async (action, since) =>
  (
    await db.query(
      `select count(*)::int n from audit_log where action = $1 and "createdAt" >= $2`,
      [action, since],
    )
  ).rows[0].n;

const busy = (
  await db.query(`select count(*)::int n from discovery_run where status in ('queued','running')`)
).rows[0].n;
if (busy) {
  console.log(`FAIL  ${busy} discovery run(s) already queued/running: run on an idle queue`);
  process.exit(1);
}
// Start from a clean MOCK slate so "created" counts are deterministic. Mock provider ids are not
// area-scoped, so MOCK rows from any earlier run (integration tests, manual runs) are cleared.
await db.query(`delete from business where provider = 'mock-discovery'`);
const t0 = new Date();

// 1. Users: seeded owner, plus a throwaway operator and viewer created through Better Auth.
const { auth } = await import("../src/lib/auth.ts");
const stamp = Date.now();
const mk = async (role) => {
  const email = `${role}-disc-${stamp}@kalpix.local`;
  const password = `${role[0].toUpperCase()}${role.slice(1)}-Disc-Pass-2026!`;
  const res = await auth.api.createUser({ body: { email, password, name: `Discovery ${role}` } });
  await db.query(`update "user" set role = $1 where id = $2`, [role, res.user.id]);
  return { email, password, id: res.user.id };
};
const viewerU = await mk("viewer");
const operatorU = await mk("operator");
const owner = await signIn(ownerEmail, ownerPassword);
const viewer = await signIn(viewerU.email, viewerU.password);
const operator = await signIn(operatorU.email, operatorU.password);
check(
  "owner, operator and viewer sign in",
  [owner, viewer, operator].every((s) => s.status === 200),
);

// 2. RBAC on the run API
const runBody = (key) => ({
  area: AREA,
  categories: CATEGORIES,
  provider: "mock",
  idempotencyKey: key,
});
const vPost = await startRun(viewer.cookie, runBody(crypto.randomUUID()));
check("viewer POST /api/discovery/runs is 403", vPost.status === 403, String(vPost.status));
// The middleware answers cookieless API requests with 401 JSON (pages still redirect to /login).
const anonPost = await fetch(`${BASE}/api/discovery/runs`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: BASE },
  body: JSON.stringify(runBody(crypto.randomUUID())),
  redirect: "manual",
});
const anonPostBody = await anonPost.json().catch(() => null);
check(
  "anonymous POST /api/discovery/runs is 401 JSON",
  anonPost.status === 401 && anonPostBody?.error === "unauthorized",
  String(anonPost.status),
);
const anonExport = await get("/api/businesses/export");
check(
  "anonymous GET /api/businesses/export is 401 (no redirect)",
  anonExport.status === 401 && !anonExport.headers.get("location"),
  String(anonExport.status),
);
const xo = await fetch(`${BASE}/api/discovery/runs`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    origin: "https://evil.example",
    cookie: owner.cookie,
  },
  body: JSON.stringify(runBody(crypto.randomUUID())),
});
check("cross-origin POST is refused", xo.status === 403, String(xo.status));

// 3. Idempotent queueing (operator, then owner, with the same key)
const key1 = crypto.randomUUID();
const a = await startRun(operator.cookie, runBody(key1));
check(
  "operator POST queues a MOCK run (202)",
  a.status === 202 && a.json.created === true && a.json.run?.provider === "mock-discovery",
  `${a.status} ${a.json.error ?? ""}`,
);
const runId = a.json.run?.id;
const b = await startRun(operator.cookie, runBody(key1));
check(
  "operator re-POST with same key returns the same run (200, created=false)",
  b.status === 200 && b.json.run?.id === runId && b.json.created === false,
  String(b.status),
);
const c = await startRun(owner.cookie, runBody(key1));
check("owner POST with same key returns the same run", c.json.run?.id === runId, String(c.status));
const d = await startRun(owner.cookie, runBody(crypto.randomUUID()));
check(
  "owner POST of an identical queued run (new key) is deduped to the same run",
  d.json.run?.id === runId && d.json.created === false,
  String(d.status),
);
const queuedRows = (
  await db.query(`select count(*)::int n from discovery_run where "createdAt" >= $1`, [t0])
).rows[0].n;
check("exactly one run row queued", queuedRows === 1, `${queuedRows}`);

// 4. Worker drains the queue
let out = "";
try {
  out = drainWorker();
} catch (err) {
  out = String(err.stdout ?? "") + String(err.stderr ?? "");
}
check(
  "pnpm worker:once processed the run",
  /processed 1 run/.test(out),
  out.trim().split("\n").pop(),
);
const run1 = (await db.query(`select * from discovery_run where id = $1`, [runId])).rows[0];
check(
  "run 1 succeeded with counts (found 8, new 6, dupes 2)",
  run1?.status === "succeeded" &&
    run1.foundCount === 8 &&
    run1.createdCount === 6 &&
    run1.duplicateCount === 2 &&
    run1.updatedCount === 0,
  run1
    ? `${run1.status} ${run1.foundCount}/${run1.createdCount}/${run1.updatedCount}/${run1.duplicateCount}`
    : "missing",
);
const afterRun1 = await mockCount();
check("6 MOCK businesses stored", afterRun1 === 6, `${afterRun1}`);

// 5. Pages
const runsPage = await get("/discovery", owner.cookie);
const runsHtml = text(await runsPage.text());
check("runs page renders", runsPage.status === 200, String(runsPage.status));
check(
  "runs page shows the run with MOCK badge, status and counts",
  runsHtml.includes(`/businesses?run=${runId}`) &&
    runsHtml.includes(">MOCK<") &&
    runsHtml.includes("succeeded") &&
    runsHtml.includes("2/2 categories") &&
    />8<\/td>/.test(runsHtml) &&
    />6<\/td>/.test(runsHtml),
);
const viewerRuns = await get("/discovery", viewer.cookie);
check("viewer can read the runs page", viewerRuns.status === 200, String(viewerRuns.status));

const listPage = await get(`/businesses?run=${runId}`, owner.cookie);
const listHtml = text(await listPage.text());
check("businesses list renders", listPage.status === 200, String(listPage.status));
check(
  "businesses list shows MOCK rows",
  ["Restaurants and cafes", "Garages and repair"].every((l) =>
    [1, 2, 3].every((i) => listHtml.includes(`MOCK ${l} ${i}`)),
  ) && listHtml.includes(">MOCK<"),
);
const biz = (
  await db.query(
    `select id, "providerId", "alternateIds" from business where provider = 'mock-discovery' and "providerId" = 'mock/restaurants/1' and lat between 15.84 and 15.88`,
  )
).rows[0];
const detail = await get(`/businesses/${biz?.id}`, owner.cookie);
const detailHtml = text(await detail.text());
check("business detail renders", detail.status === 200, String(detail.status));
check(
  "detail page shows provenance (provider id, source URL, run, merged record)",
  detailHtml.includes("Provenance") &&
    detailHtml.includes("mock/restaurants/1") &&
    detailHtml.includes("https://example.com/mock/restaurants/1") &&
    detailHtml.includes("First found in run") &&
    detailHtml.includes("mock-discovery:mock/restaurants/1-dup"),
);
check(
  "unknown business id 404s",
  (await get(`/businesses/not-a-uuid`, owner.cookie)).status === 404,
);

// 6. CSV export: admin+ only, audited
const vExp = await get(`/api/businesses/export?run=${runId}`, viewer.cookie);
check("viewer export is 403", vExp.status === 403, String(vExp.status));
const oExpDenied = await get(`/api/businesses/export?run=${runId}`, operator.cookie);
check("operator export is 403", oExpDenied.status === 403, String(oExpDenied.status));
const exp = await get(`/api/businesses/export?run=${runId}`, owner.cookie);
const csv = await exp.text();
const lines = csv.trim().split(/\r?\n/);
check(
  "owner CSV export works (header + 6 rows, text/csv attachment)",
  exp.status === 200 &&
    (exp.headers.get("content-type") ?? "").startsWith("text/csv") &&
    (exp.headers.get("content-disposition") ?? "").includes("attachment") &&
    lines[0].startsWith("id,name,category") &&
    lines.length === 7,
  `${exp.status}, ${lines.length - 1} rows`,
);
check("export is audited (business.export)", (await auditCount("business.export", t0)) === 1);
check(
  "run start is audited once (discovery.run_start)",
  (await auditCount("discovery.run_start", t0)) === 1,
);

// 7. A second identical run creates no duplicate businesses
const e = await startRun(owner.cookie, runBody(crypto.randomUUID()));
check(
  "second identical run queued (202)",
  e.status === 202 && e.json.run?.id !== runId,
  String(e.status),
);
try {
  drainWorker();
} catch {
  /* checked below */
}
const run2 = (await db.query(`select * from discovery_run where id = $1`, [e.json.run?.id]))
  .rows[0];
check(
  "second run: 0 created, 6 updated, 2 merged",
  run2?.status === "succeeded" &&
    run2.createdCount === 0 &&
    run2.updatedCount === 6 &&
    run2.duplicateCount === 2,
  run2
    ? `${run2.status} new=${run2.createdCount} upd=${run2.updatedCount} dup=${run2.duplicateCount}`
    : "missing",
);
check("still 6 MOCK businesses (no duplicates)", (await mockCount()) === 6);
check("both run starts audited", (await auditCount("discovery.run_start", t0)) === 2);

// Cleanup: drop the MOCK rows (fake data) and suspend the throwaway users. Runs and audit rows
// stay; the audit log is append-only. KEEP_MOCK=1 keeps the rows (e.g. for screenshots).
if (!process.env.KEEP_MOCK)
  await db.query(`delete from business where provider = 'mock-discovery'`);
await db.query(`update "user" set banned = true where id = any($1)`, [[viewerU.id, operatorU.id]]);
await db.end();
console.log(failures ? `\n${failures} check(s) failed` : "\nAll discovery checks passed");
process.exit(failures ? 1 : 0);
