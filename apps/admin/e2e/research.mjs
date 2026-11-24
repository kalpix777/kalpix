// Phase 4 research end to end against a running admin (pnpm start) and a real PostgreSQL.
// MOCK providers only (no network): a mock discovery run creates 6 MOCK businesses (#1 of each
// category has a website and the listing phone +910000000000), then a mock research run reads
// those "websites" (the mock returns a different phone, so phone becomes a conflict). Both runs are
// queued through the API and drained with `pnpm worker:once`.
// Usage: BASE_URL=http://localhost:3000 tsx e2e/research.mjs  (KEEP_MOCK=1 keeps the MOCK rows)
import "dotenv/config";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import pg from "pg";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ownerEmail = process.env.SEED_OWNER_EMAIL;
const ownerPassword = process.env.SEED_OWNER_PASSWORD;
const AREA = "15.84,74.49,15.88,74.53";
const CATEGORIES = ["garages", "restaurants"];
let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
async function post(path, cookie, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
    redirect: "manual",
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
function drainWorker() {
  try {
    return execFileSync("pnpm", ["-F", "@kalpix/worker", "once"], {
      env: { ...process.env, DISCOVERY_PROVIDER: "mock", RESEARCH_PROVIDER: "mock" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    return String(err.stdout ?? "") + String(err.stderr ?? "");
  }
}
const text = (html) => html.replace(/<!-- -->/g, "");

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const auditCount = async (action, since) =>
  (
    await one(`select count(*)::int n from audit_log where action = $1 and "createdAt" >= $2`, [
      action,
      since,
    ])
  ).n;
const mockFactCount = async () =>
  (
    await one(
      `select count(*)::int n from research_fact f join business b on b.id = f."businessId"
       where b.provider = 'mock-discovery'`,
    )
  ).n;

const busy =
  (await one(`select count(*)::int n from discovery_run where status in ('queued','running')`)).n +
  (await one(`select count(*)::int n from research_run where status in ('queued','running')`)).n;
if (busy) {
  console.log(`FAIL  ${busy} discovery/research run(s) already queued/running: use an idle queue`);
  process.exit(1);
}
// Clean MOCK slate (facts and per-business research rows cascade from business).
await db.query(`delete from business where provider = 'mock-discovery'`);
const t0 = new Date();

// 1. Users
const { auth } = await import("../src/lib/auth.ts");
const stamp = Date.now();
const mk = async (role) => {
  const email = `${role}-res-${stamp}@kalpix.local`;
  const password = `${role[0].toUpperCase()}${role.slice(1)}-Res-Pass-2026!`;
  const res = await auth.api.createUser({ body: { email, password, name: `Research ${role}` } });
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

// 2. Mock discovery creates the businesses to research
const disc = await post("/api/discovery/runs", operator.cookie, {
  area: AREA,
  categories: CATEGORIES,
  provider: "mock",
  idempotencyKey: crypto.randomUUID(),
});
check("mock discovery run queued (202)", disc.status === 202, String(disc.status));
const discoveryRunId = disc.json?.run?.id;
let out = drainWorker();
check("worker processed the discovery run", /processed 1 discovery run/.test(out));
const mockBiz = (await one(`select count(*)::int n from business where provider='mock-discovery'`))
  .n;
check("6 MOCK businesses stored", mockBiz === 6, String(mockBiz));

// 3. RBAC on POST /api/research/runs
const body = (key) => ({
  scope: "discovery_run",
  discoveryRunId,
  provider: "mock",
  idempotencyKey: key,
});
const anon = await post("/api/research/runs", null, body(crypto.randomUUID()));
check(
  "anonymous POST /api/research/runs is 401 JSON",
  anon.status === 401 && anon.json !== null && typeof anon.json.error === "string",
  String(anon.status),
);
const vPost = await post("/api/research/runs", viewer.cookie, body(crypto.randomUUID()));
check("viewer POST /api/research/runs is 403", vPost.status === 403, String(vPost.status));
const vGet = await get("/api/research/runs", viewer.cookie);
check("viewer GET /api/research/runs is 200", vGet.status === 200, String(vGet.status));
const xo = await fetch(`${BASE}/api/research/runs`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    origin: "https://evil.example",
    cookie: owner.cookie,
  },
  body: JSON.stringify(body(crypto.randomUUID())),
});
check("cross-origin POST is refused", xo.status === 403, String(xo.status));
const bad = await post("/api/research/runs", operator.cookie, { scope: "nope" });
check("invalid body is 400", bad.status === 400, String(bad.status));

// 4. Idempotent queueing
const key1 = crypto.randomUUID();
const a = await post("/api/research/runs", operator.cookie, body(key1));
check(
  "operator POST queues a MOCK research run (202)",
  a.status === 202 && a.json?.created === true && a.json?.run?.provider === "mock-research",
  `${a.status} ${a.json?.error ?? ""}`,
);
const runId = a.json?.run?.id;
const b = await post("/api/research/runs", operator.cookie, body(key1));
check(
  "re-POST with same key returns the same run (200, created=false)",
  b.status === 200 && b.json?.run?.id === runId && b.json?.created === false,
  String(b.status),
);
const c = await post("/api/research/runs", owner.cookie, body(crypto.randomUUID()));
check(
  "identical queued run with a new key is deduped",
  c.json?.run?.id === runId && c.json?.created === false,
  String(c.status),
);
const queued = (await one(`select count(*)::int n from research_run where "createdAt" >= $1`, [t0]))
  .n;
check("exactly one research run row queued", queued === 1, String(queued));

// 5. Worker drains the research run
out = drainWorker();
check(
  "worker processed the research run",
  /processed 1 research run/.test(out),
  out.trim().split("\n").pop(),
);
const run1 = await one(`select * from research_run where id = $1`, [runId]);
check(
  "run succeeded: 6 done, 2 ok, 4 no website, 0 broken/blocked/error, 2 businesses with conflicts",
  run1?.status === "succeeded" &&
    run1.totalCount === 6 &&
    run1.processedCount === 6 &&
    run1.okCount === 2 &&
    run1.noWebsiteCount === 4 &&
    run1.brokenCount + run1.blockedCount + run1.errorCount === 0 &&
    run1.conflictCount === 2 &&
    run1.factCount > 0 &&
    run1.newFactCount === run1.factCount,
  run1
    ? `${run1.status} ${run1.processedCount}/${run1.totalCount} ok=${run1.okCount} nw=${run1.noWebsiteCount} facts=${run1.factCount} new=${run1.newFactCount} confl=${run1.conflictCount}`
    : "missing",
);
const facts1 = await mockFactCount();
check("facts stored for MOCK businesses", facts1 > 0, String(facts1));
const researched = (
  await one(
    `select count(*)::int n from business where provider='mock-discovery' and "lastResearchedAt" is not null`,
  )
).n;
check("all 6 MOCK businesses marked researched", researched === 6, String(researched));
check("run start audited (research.run_start)", (await auditCount("research.run_start", t0)) === 1);

// 6. Pages
const rPage = await get("/research", owner.cookie);
const rHtml = text(await rPage.text());
check("research page renders", rPage.status === 200, String(rPage.status));
check(
  "research page shows the MOCK run with status and counts",
  rHtml.includes(">MOCK<") &&
    rHtml.includes("succeeded") &&
    rHtml.includes("6/6 done") &&
    rHtml.includes(`${run1?.newFactCount} new`),
);
const vrPage = await get("/research", viewer.cookie);
check("viewer can read the research page", vrPage.status === 200, String(vrPage.status));

const list = await get(`/businesses?run=${discoveryRunId}`, owner.cookie);
const listHtml = text(await list.text());
check("businesses list renders", list.status === 200, String(list.status));
check(
  "businesses list has a Research column with outcomes and conflicts",
  listHtml.includes(">Research</th>") &&
    listHtml.includes("Researched") &&
    listHtml.includes("No website") &&
    listHtml.includes("conflicting"),
);
const conflictsList = text(
  await (await get(`/businesses?run=${discoveryRunId}&research=conflicts`, owner.cookie)).text(),
);
check(
  "research=conflicts filter shows only the businesses with conflicts",
  conflictsList.includes("MOCK Garages and repair 1") &&
    conflictsList.includes("MOCK Restaurants and cafes 1") &&
    !conflictsList.includes("MOCK Restaurants and cafes 2"),
);

const biz = await one(
  `select id, website from business where provider='mock-discovery' and "providerId"='mock/restaurants/1'`,
);
const det = await get(`/businesses/${biz?.id}`, owner.cookie);
const detHtml = text(await det.text());
check("business detail renders", det.status === 200, String(det.status));
const phones = (
  await db.query(
    `select value, "verificationStatus" s, "sourceUrl" from research_fact where "businessId"=$1 and field='phone'`,
    [biz?.id],
  )
).rows;
const resPhone = phones.find((p) => p.value !== "+910000000000");
check(
  "phone facts conflict in the database (listing vs website)",
  phones.length >= 2 &&
    phones.some((p) => p.value === "+910000000000") &&
    phones.every((p) => p.s === "conflicting"),
  phones.map((p) => `${p.value}:${p.s}`).join(", "),
);
check(
  "detail shows research facts with provenance (values, website source URL, MOCK)",
  detHtml.includes("+910000000000") &&
    !!resPhone &&
    detHtml.includes(resPhone.value) &&
    detHtml.includes(biz.website) &&
    detHtml.includes("mock-restaurants-1@mock.invalid") &&
    detHtml.includes("Collected (IST)"),
);
check(
  "detail shows the Conflicts marker naming Phone",
  />Conflicts<\/dt><dd[^>]*><span[^>]*>[^<]*phone/i.test(detHtml),
);
check(
  "detail marks the phone conflicting",
  detHtml.includes("conflicting") && detHtml.includes("bg-amber-50/70"),
);

// 7. Re-running research creates no duplicate facts
const e = await post("/api/research/runs", owner.cookie, body(crypto.randomUUID()));
check(
  "second research run queued (202)",
  e.status === 202 && e.json?.run?.id !== runId,
  String(e.status),
);
drainWorker();
const run2 = await one(`select * from research_run where id = $1`, [e.json?.run?.id]);
check(
  "second run succeeded with 0 new facts",
  run2?.status === "succeeded" && run2.newFactCount === 0 && run2.processedCount === 6,
  run2 ? `${run2.status} new=${run2.newFactCount}` : "missing",
);
const facts2 = await mockFactCount();
check("fact rows unchanged (0 duplicates)", facts2 === facts1, `${facts1} -> ${facts2}`);
check("both research run starts audited", (await auditCount("research.run_start", t0)) === 2);

if (!process.env.KEEP_MOCK)
  await db.query(`delete from business where provider = 'mock-discovery'`);
await db.query(`update "user" set banned = true where id = any($1)`, [[viewerU.id, operatorU.id]]);
await db.end();
console.log(failures ? `\n${failures} check(s) failed` : "\nAll research checks passed");
process.exit(failures ? 1 : 0);
