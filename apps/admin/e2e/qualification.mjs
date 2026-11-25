// Phase 5 verification + qualification end to end against a running admin (pnpm start) and a real
// PostgreSQL. MOCK providers only (no network, no real model): a mock discovery run creates 6 MOCK
// businesses, a mock research run reads their "websites", then a qualification run with the MOCK
// AI model verifies facts, scores and tiers every business. Runs are queued through the API and
// drained with `pnpm worker:once`. Manual fact overrides are submitted through the real server
// action forms on the business detail page (no-JS form post with the rendered $ACTION_ID field).
// Usage: BASE_URL=http://localhost:3000 tsx e2e/qualification.mjs  (KEEP_MOCK=1 keeps MOCK rows)
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
      env: {
        ...process.env,
        DISCOVERY_PROVIDER: "mock",
        RESEARCH_PROVIDER: "mock",
        QUALIFICATION_AI_PROVIDER: "mock",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    return String(err.stdout ?? "") + String(err.stderr ?? "");
  }
}
const text = (html) => html.replace(/<!-- -->/g, "");
const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
const decode = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/**
 * Finds the <form> holding `<input name="factId" value=factId>` whose submit button says `label`,
 * and returns its hidden fields (including the server action's $ACTION_ID_ / $ACTION_REF_ inputs).
 */
function findForm(html, factId, label) {
  const forms = html.match(/<form\b[\s\S]*?<\/form>/g) ?? [];
  for (const f of forms) {
    if (!f.includes(`value="${factId}"`) || !f.includes(label)) continue;
    const fields = {};
    for (const m of f.matchAll(/<input\b[^>]*>/g)) {
      const name = /\bname="([^"]*)"/.exec(m[0])?.[1];
      if (!name) continue;
      fields[decode(name)] = decode(/\bvalue="([^"]*)"/.exec(m[0])?.[1] ?? "");
    }
    return fields;
  }
  return null;
}
async function submitForm(path, cookie, fields) {
  const fd = new globalThis.FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { origin: BASE, cookie },
    body: fd,
    redirect: "manual",
  });
  return { status: r.status, location: r.headers.get("location") ?? "" };
}

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
const qualCount = async (runId) =>
  (await one(`select count(*)::int n from business_qualification where "runId" = $1`, [runId])).n;

const busy =
  (await one(`select count(*)::int n from discovery_run where status in ('queued','running')`)).n +
  (await one(`select count(*)::int n from research_run where status in ('queued','running')`)).n +
  (await one(`select count(*)::int n from qualification_run where status in ('queued','running')`))
    .n;
if (busy) {
  console.log(`FAIL  ${busy} run(s) already queued/running: use an idle queue`);
  process.exit(1);
}
// Clean MOCK slate (facts, research and qualification rows cascade from business).
await db.query(`delete from business where provider = 'mock-discovery'`);
const t0 = new Date();

// 1. Users
const { auth } = await import("../src/lib/auth.ts");
const stamp = Date.now();
const mk = async (role) => {
  const email = `${role}-qual-${stamp}@kalpix.local`;
  const password = `${role[0].toUpperCase()}${role.slice(1)}-Qual-Pass-2026!`;
  const res = await auth.api.createUser({ body: { email, password, name: `Qualify ${role}` } });
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

// 2. Mock discovery then mock research create researched businesses
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
const res = await post("/api/research/runs", operator.cookie, {
  scope: "discovery_run",
  discoveryRunId,
  provider: "mock",
  idempotencyKey: crypto.randomUUID(),
});
check("mock research run queued (202)", res.status === 202, String(res.status));
out = drainWorker();
check("worker processed the research run", /processed 1 research run/.test(out));
const mockBiz = (
  await one(
    `select count(*)::int n from business where provider='mock-discovery' and "lastResearchedAt" is not null`,
  )
).n;
check("6 researched MOCK businesses", mockBiz === 6, String(mockBiz));
const facts0 = await mockFactCount();

// 3. RBAC and validation on POST /api/qualification/runs
const body = (key, ai = "mock") => ({
  scope: "discovery_run",
  discoveryRunId,
  ai,
  idempotencyKey: key,
});
const anon = await post("/api/qualification/runs", null, body(crypto.randomUUID()));
check(
  "anonymous POST /api/qualification/runs is 401 JSON",
  anon.status === 401 && anon.json !== null && typeof anon.json.error === "string",
  String(anon.status),
);
const vPost = await post("/api/qualification/runs", viewer.cookie, body(crypto.randomUUID()));
check("viewer POST /api/qualification/runs is 403", vPost.status === 403, String(vPost.status));
const vGet = await get("/api/qualification/runs", viewer.cookie);
check("viewer GET /api/qualification/runs is 200", vGet.status === 200, String(vGet.status));
const xo = await fetch(`${BASE}/api/qualification/runs`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    origin: "https://evil.example",
    cookie: owner.cookie,
  },
  body: JSON.stringify(body(crypto.randomUUID())),
});
check("cross-origin POST is refused (403)", xo.status === 403, String(xo.status));
const bad = await post("/api/qualification/runs", operator.cookie, { scope: "nope" });
check("invalid body is 400", bad.status === 400, String(bad.status));
const gem = await post(
  "/api/qualification/runs",
  operator.cookie,
  body(crypto.randomUUID(), "gemini"),
);
check(
  "explicit not-ready AI provider (gemini, no key/not enabled) is 409",
  gem.status === 409 && /not ready/i.test(gem.json?.error ?? ""),
  `${gem.status} ${gem.json?.error ?? ""}`.slice(0, 160),
);
const noRun = (
  await one(`select count(*)::int n from qualification_run where "createdAt" >= $1`, [t0])
).n;
check("refused requests created no qualification run", noRun === 0, String(noRun));

// 4. Idempotent queueing
const key1 = crypto.randomUUID();
const a = await post("/api/qualification/runs", operator.cookie, body(key1));
check(
  "operator POST queues a qualification run with MOCK AI (202)",
  a.status === 202 && a.json?.created === true && a.json?.run?.aiProvider === "mock-model",
  `${a.status} ${a.json?.run?.aiProvider ?? a.json?.error ?? ""}`,
);
const runId = a.json?.run?.id;
const b = await post("/api/qualification/runs", operator.cookie, body(key1));
check(
  "re-POST with same key returns the same run (200, created=false)",
  b.status === 200 && b.json?.run?.id === runId && b.json?.created === false,
  String(b.status),
);
const c = await post("/api/qualification/runs", owner.cookie, body(crypto.randomUUID()));
check(
  "identical queued run with a new key is deduped",
  c.json?.run?.id === runId && c.json?.created === false,
  String(c.status),
);
const queued = (
  await one(`select count(*)::int n from qualification_run where "createdAt" >= $1`, [t0])
).n;
check("exactly one qualification run row queued", queued === 1, String(queued));
check(
  "run start audited (qualification.run_start)",
  (await auditCount("qualification.run_start", t0)) === 1,
);

// 5. Worker drains the qualification run
out = drainWorker();
check(
  "worker processed the qualification run",
  /processed 1 qualification run/.test(out),
  out.trim().split("\n").pop(),
);
const run1 = await one(`select * from qualification_run where id = $1`, [runId]);
const tierSum = run1
  ? run1.hotCount + run1.warmCount + run1.coldCount + run1.disqualifiedCount
  : -1;
check(
  "run succeeded: 6/6 qualified, tiers add up, facts checked, MOCK AI ok, cost 0",
  run1?.status === "succeeded" &&
    run1.totalCount === 6 &&
    run1.processedCount === 6 &&
    tierSum === 6 &&
    run1.errorCount === 0 &&
    run1.factsCheckedCount > 0 &&
    run1.aiOkCount > 0 &&
    run1.aiErrorCount === 0 &&
    (run1.aiCostMinor ?? 0) === 0,
  run1
    ? `${run1.status} ${run1.processedCount}/${run1.totalCount} hot=${run1.hotCount} warm=${run1.warmCount} cold=${run1.coldCount} dq=${run1.disqualifiedCount} checked=${run1.factsCheckedCount} verified=${run1.factsVerifiedCount} invalid=${run1.factsInvalidCount} aiOk=${run1.aiOkCount} aiErr=${run1.aiErrorCount}`
    : "missing",
);
const q1 = await qualCount(runId);
check("one business_qualification row per business", q1 === 6, String(q1));
const scored = (
  await one(
    `select count(*)::int n from business where provider='mock-discovery' and "latestScore" is not null and "latestTier" is not null`,
  )
).n;
check("all 6 MOCK businesses carry latest score and tier", scored === 6, String(scored));
const facts1 = await mockFactCount();
check("qualification added no facts", facts1 === facts0, `${facts0} -> ${facts1}`);

// 6. Leads page
const lPage = await get("/leads", owner.cookie);
const lHtml = text(await lPage.text());
check("leads page renders", lPage.status === 200, String(lPage.status));
check(
  "leads page shows the run with tier counts",
  lHtml.includes("Lead Qualification") &&
    lHtml.includes("succeeded") &&
    /Hot \d+ · Warm \d+ · Cold \d+ · Disqualified \d+/.test(lHtml.replace(/<[^>]+>/g, "")),
);
const ranked = (
  await db.query(
    `select name, "latestScore" s from business where provider='mock-discovery' and "latestTier" <> 'disqualified'
     order by "latestScore" desc, name`,
  )
).rows;
const positions = ranked.map((r) => lHtml.indexOf(esc(r.name)));
check(
  "leads page lists the qualified MOCK leads ranked by score",
  ranked.length > 0 &&
    positions.every((p) => p > 0) &&
    positions.every((p, i) => i === 0 || ranked[i - 1].s === ranked[i].s || p > positions[i - 1]) &&
    lHtml.includes("Ranked leads") &&
    lHtml.includes("MOCK test data"),
  ranked.map((r) => `${r.name}:${r.s}`).join(", "),
);
const vlPage = await get("/leads", viewer.cookie);
const vlHtml = text(await vlPage.text());
check(
  "viewer reads /leads without start-run or retry/cancel forms",
  vlPage.status === 200 &&
    !vlHtml.includes('name="scope"') &&
    !vlHtml.includes("$ACTION_ID_") &&
    vlHtml.includes("Ranked leads"),
  String(vlPage.status),
);

// 7. Business detail: score, tier, reasons, MOCK AI card
const biz = await one(
  `select id, name, "latestScore", "latestTier" from business where provider='mock-discovery' and "providerId"='mock/restaurants/1'`,
);
const qrow = await one(
  `select score, tier, reasons, "aiStatus", "aiIsMock", "aiSummary" from business_qualification where "runId"=$1 and "businessId"=$2`,
  [runId, biz?.id],
);
const det = await get(`/businesses/${biz?.id}`, owner.cookie);
const detHtml = text(await det.text());
check("business detail renders", det.status === 200, String(det.status));
const firstReason = Array.isArray(qrow?.reasons) ? qrow.reasons[0]?.text : null;
check(
  "detail shows score, tier and reasons",
  !!qrow &&
    qrow.score === biz.latestScore &&
    detHtml.includes(">Reasons</h3>") &&
    new RegExp(`>${qrow.score}</span>`).test(detHtml) &&
    !!firstReason &&
    detHtml.includes(esc(firstReason)),
  qrow ? `score=${qrow.score} tier=${qrow.tier}` : "missing",
);
check(
  "detail shows the AI MOCK card (not verified, does not change the score)",
  qrow?.aiStatus === "ok" &&
    qrow.aiIsMock === true &&
    /^MOCK/.test(qrow.aiSummary ?? "") &&
    detHtml.includes("AI suggestion — not verified") &&
    detHtml.includes("MOCK model output") &&
    detHtml.includes("does not change the score"),
  qrow ? `ai=${qrow.aiStatus} mock=${qrow.aiIsMock}` : "missing",
);
const vdHtml = text(await (await get(`/businesses/${biz?.id}`, viewer.cookie)).text());
check(
  "viewer sees the detail without override or qualify forms",
  vdHtml.includes("AI suggestion — not verified") &&
    !vdHtml.includes("Save override") &&
    !vdHtml.includes("$ACTION_ID_"),
);

// 8. Manual fact override through the server action form (reason required, audited)
const fact = await one(
  `select id, field, "verificationStatus" s from research_fact where "businessId"=$1 and field='email' order by "createdAt" limit 1`,
  [biz?.id],
);
check("the business has an email fact to override", !!fact, fact ? `${fact.field}:${fact.s}` : "");
const form = findForm(detHtml, fact?.id, "Save override");
check(
  "detail renders the override form for operators+",
  !!form && Object.keys(form).some((k) => k.startsWith("$ACTION_ID_")),
);
const reason = `E2E checked by phone ${stamp}`;
const sub = await submitForm(`/businesses/${biz?.id}`, owner.cookie, {
  ...form,
  status: "invalid",
  reason,
});
check(
  "override submit redirects back with ok",
  [303, 302, 307].includes(sub.status) && sub.location.includes("ok="),
  `${sub.status} ${decodeURIComponent(sub.location).slice(0, 120)}`,
);
const f2 = await one(`select * from research_fact where id=$1`, [fact?.id]);
check(
  "override saved with status, reason, actor and manual method",
  f2?.verificationStatus === "invalid" &&
    f2.verificationOverride === true &&
    f2.overrideReason === reason &&
    f2.verificationMethod === "manual" &&
    f2.verifiedByLabel === ownerEmail,
  f2 ? `${f2.verificationStatus} override=${f2.verificationOverride}` : "missing",
);
const ov = await one(
  `select metadata from audit_log where action='fact.verify_override' and "entityId"=$1 and "createdAt" >= $2`,
  [fact?.id, t0],
);
check(
  "audit fact.verify_override row with reason",
  ov?.metadata?.reason === reason && ov.metadata.to === "invalid",
);
const shortForm = findForm(
  text(await (await get(`/businesses/${biz?.id}`, owner.cookie)).text()),
  fact?.id,
  "Save override",
);
const subBad = await submitForm(`/businesses/${biz?.id}`, owner.cookie, {
  ...shortForm,
  status: "verified",
  reason: "x",
});
const f2b = await one(`select "verificationStatus" s from research_fact where id=$1`, [fact?.id]);
check(
  "override with a too-short reason is refused and changes nothing",
  subBad.location.includes("error=") && f2b?.s === "invalid",
  `${subBad.status} ${f2b?.s}`,
);
const det2Html = text(await (await get(`/businesses/${biz?.id}`, owner.cookie)).text());
check(
  "detail shows the invalid fact with the Override badge and reason",
  det2Html.includes(reason) && det2Html.includes(">Override<") && det2Html.includes(">invalid<"),
);
// a verified override on the phone fact (kept for screenshots / next run)
const phone = await one(
  `select id from research_fact where "businessId"=$1 and field='phone' order by "createdAt" limit 1`,
  [biz?.id],
);
const pForm = findForm(det2Html, phone?.id, "Save override");
const pSub = await submitForm(`/businesses/${biz?.id}`, owner.cookie, {
  ...pForm,
  status: "verified",
  reason: `E2E called the listing number ${stamp}`,
});
const p2 = await one(
  `select "verificationStatus" s, "verificationOverride" o from research_fact where id=$1`,
  [phone?.id],
);
check(
  "phone fact override to verified saved",
  pSub.location.includes("ok=") && p2?.s === "verified" && p2.o === true,
  `${pSub.status} ${p2?.s}`,
);

// 9. Clear an override (audited)
const clearFields = findForm(det2Html, fact?.id, "Remove override");
const clr = await submitForm(`/businesses/${biz?.id}`, owner.cookie, clearFields ?? {});
const f3 = await one(`select * from research_fact where id=$1`, [fact?.id]);
check(
  "clear override resets the fact to unverified",
  !!clearFields &&
    clr.location.includes("ok=") &&
    f3?.verificationOverride === false &&
    f3.verificationStatus === "unverified" &&
    f3.overrideReason === null,
  `${clr.status} ${f3?.verificationStatus}`,
);
check(
  "audit fact.verify_override_clear row",
  (await auditCount("fact.verify_override_clear", t0)) === 1,
);

// 10. Re-running creates no duplicates; overrides apply on the next run
const e = await post("/api/qualification/runs", owner.cookie, body(crypto.randomUUID()));
check(
  "second qualification run queued (202)",
  e.status === 202 && e.json?.run?.id !== runId,
  String(e.status),
);
drainWorker();
const run2 = await one(`select * from qualification_run where id = $1`, [e.json?.run?.id]);
check(
  "second run succeeded for 6 businesses",
  run2?.status === "succeeded" && run2.processedCount === 6,
  run2 ? `${run2.status} ${run2.processedCount}` : "missing",
);
check(
  "exactly one business_qualification per business per run (no duplicates)",
  (await qualCount(runId)) === 6 && (await qualCount(e.json?.run?.id)) === 6,
);
const dupRows = (
  await one(
    `select count(*)::int n from (select "runId","businessId" from business_qualification group by 1,2 having count(*) > 1) d`,
  )
).n;
check("no (run, business) pair qualified twice", dupRows === 0, String(dupRows));
const facts2 = await mockFactCount();
check(
  "fact rows unchanged after re-run (0 duplicates)",
  facts2 === facts1,
  `${facts1} -> ${facts2}`,
);
const p3 = await one(
  `select "verificationStatus" s, "verificationOverride" o from research_fact where id=$1`,
  [phone?.id],
);
check(
  "automatic pass keeps the manual phone override",
  p3?.s === "verified" && p3.o === true,
  `${p3?.s} ${p3?.o}`,
);
check(
  "both qualification run starts audited",
  (await auditCount("qualification.run_start", t0)) === 2,
);

if (!process.env.KEEP_MOCK)
  await db.query(`delete from business where provider = 'mock-discovery'`);
await db.query(`update "user" set banned = true where id = any($1)`, [[viewerU.id, operatorU.id]]);
await db.end();
console.log(failures ? `\n${failures} check(s) failed` : "\nAll qualification checks passed");
process.exit(failures ? 1 : 0);
