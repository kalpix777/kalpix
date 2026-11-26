// Phase 6 CRM API end to end against a running admin (pnpm start) and a real PostgreSQL. No
// outbound messaging, no network beyond the local server. Businesses are inserted directly with a
// qualification tier; everything else goes through the HTTP API: promotion (idempotent, never
// disqualified), list filters, optimistic concurrency (409), stage rules (lost reason, reopen by
// admin only, do-not-contact), assignment, timeline + 15-minute note edits, tasks, contacts, tags,
// DNC set/clear, CSV export (admin only, formula-safe, DNC channels blanked) and CSV import.
// Usage: BASE_URL=http://localhost:3000 tsx e2e/crm.mjs
import "dotenv/config";
import crypto from "node:crypto";
import pg from "pg";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ownerEmail = process.env.SEED_OWNER_EMAIL;
const ownerPassword = process.env.SEED_OWNER_PASSWORD;
let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` (${extra})` : ""}`);
  if (!cond) failures++;
};
async function signIn(email, password) {
  for (let i = 0; i < 7; i++) {
    const r = await fetch(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email, password }),
    });
    if (r.status !== 429) {
      const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
      return { status: r.status, cookie };
    }
    await sleep(4000);
  }
  return { status: 429, cookie: "" };
}
async function call(method, path, cookie, body, extraHeaders = {}) {
  const headers = { origin: BASE, ...(cookie ? { cookie } : {}), ...extraHeaders };
  let payload;
  if (body !== undefined) {
    if (typeof body === "string") payload = body;
    else {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
  }
  const r = await fetch(`${BASE}${path}`, { method, headers, body: payload, redirect: "manual" });
  const raw = await r.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }
  return { status: r.status, json, text: raw, type: r.headers.get("content-type") ?? "" };
}
const get = (p, c) => call("GET", p, c);
const post = (p, c, b, h) => call("POST", p, c, b, h);
const patch = (p, c, b) => call("PATCH", p, c, b);
const put = (p, c, b) => call("PUT", p, c, b);
const del = (p, c, b) => call("DELETE", p, c, b);
const decode = (v) =>
  v
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
/** Hidden/text inputs of the first <form> whose markup contains every marker (server-action forms). */
function findForm(html, ...markers) {
  for (const f of html.match(/<form\b[\s\S]*?<\/form>/g) ?? []) {
    if (!markers.every((m) => f.includes(m))) continue;
    const fields = {};
    for (const m of f.matchAll(/<input\b[^>]*>/g)) {
      const name = /\bname="([^"]*)"/.exec(m[0])?.[1];
      if (!name || /type="(checkbox|radio|file)"/.test(m[0])) continue;
      fields[decode(name)] = decode(/\bvalue="([^"]*)"/.exec(m[0])?.[1] ?? "");
    }
    return fields;
  }
  return null;
}
async function submitForm(path, cookie, fields) {
  const fd = new globalThis.FormData();
  for (const [k, val] of Object.entries(fields)) fd.append(k, val);
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { origin: BASE, cookie },
    body: fd,
    redirect: "manual",
  });
  return { status: r.status, location: decodeURIComponent(r.headers.get("location") ?? "") };
}
const page = async (path, cookie) => {
  const r = await get(path, cookie);
  return { status: r.status, html: r.text };
};

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
const t0 = new Date();
const stamp = Date.now();
const PROVIDER = "e2e-crm";

// 1. Users
const { auth } = await import("../src/lib/auth.ts");
const mk = async (role) => {
  const email = `${role}-crm-${stamp}@kalpix.local`;
  const password = `${role[0].toUpperCase()}${role.slice(1)}-Crm-Pass-2026!`;
  const res = await auth.api.createUser({ body: { email, password, name: `CRM ${role}` } });
  await db.query(`update "user" set role = $1 where id = $2`, [role, res.user.id]);
  return { email, password, id: res.user.id };
};
const viewerU = await mk("viewer");
const operatorU = await mk("operator");
const adminU = await mk("admin");
const owner = await signIn(ownerEmail, ownerPassword);
const viewer = await signIn(viewerU.email, viewerU.password);
const operator = await signIn(operatorU.email, operatorU.password);
const admin = await signIn(adminU.email, adminU.password);
check(
  "owner, admin, operator and viewer sign in",
  [owner, admin, viewer, operator].every((s) => s.status === 200),
);

// 2. Businesses with qualification tiers (inserted directly; qualification is Phase 5's job)
const ids = {};
for (const [key, tier, score, extra] of [
  ["hot", "hot", 85, { name: `=HYPERLINK("x") E2E CRM ${stamp} hot`, phone: "+919811100001" }],
  ["warm", "warm", 60, { phone: "+919811100002" }],
  ["cold", "cold", 30, {}],
  ["dq", "disqualified", 0, {}],
]) {
  const id = crypto.randomUUID();
  ids[key] = id;
  await db.query(
    `insert into business (id, name, "normalizedName", category, provider, "providerId", lat, lon, phone,
       postcode, source, "sourceType", "sourceUrl", "collectedAt", "lastSeenAt", confidence, "latestTier",
       "latestScore", "qualifiedAt", "updatedAt")
     values ($1,$2,$3,'restaurants',$4,$5,15.85,74.5,$6,'590006','mock','mock',$7,now(),now(),0.5,$8,$9,now(),now())`,
    [
      id,
      extra.name ?? `E2E CRM ${stamp} ${key}`,
      `e2e crm ${stamp} ${key}`,
      PROVIDER,
      `${stamp}/${key}`,
      extra.phone ?? null,
      `https://example.org/${stamp}/${key}`,
      tier,
      score,
    ],
  );
}

// 3. Auth, RBAC and origin
check("no cookie GET /api/crm/leads is 401", (await get("/api/crm/leads")).status === 401);
check("viewer can list leads (200)", (await get("/api/crm/leads", viewer.cookie)).status === 200);
const promoteBody = {
  scope: "businesses",
  businessIds: [ids.hot, ids.warm, ids.cold, ids.dq],
};
check(
  "viewer cannot promote (403)",
  (await post("/api/crm/leads", viewer.cookie, promoteBody)).status === 403,
);
check(
  "cross-origin POST is refused (403)",
  (await post("/api/crm/leads", operator.cookie, promoteBody, { origin: "https://evil.example" }))
    .status === 403,
);
check(
  "invalid body is 400",
  (await post("/api/crm/leads", operator.cookie, { scope: "everything" })).status === 400,
);
check(
  "non-JSON body is 400",
  (
    await post("/api/crm/leads", operator.cookie, "not json", {
      "content-type": "application/json",
    })
  ).status === 400,
);

// 4. Promotion: hot + warm by default, never disqualified; idempotent
const p1 = await post("/api/crm/leads", operator.cookie, promoteBody);
check(
  "operator promotes hot and warm (201, 2 created)",
  p1.status === 201 && p1.json?.created?.length === 2,
  `${p1.status} ${JSON.stringify(p1.json?.skipped)}`,
);
check(
  "cold skipped (tier not selected), disqualified skipped",
  p1.json?.skipped?.tier_not_selected === 1 && p1.json?.skipped?.disqualified === 1,
);
const p2 = await post("/api/crm/leads", operator.cookie, promoteBody);
check(
  "re-promotion creates nothing (200, has_lead 2)",
  p2.status === 200 && p2.json?.created?.length === 0 && p2.json?.skipped?.has_lead === 2,
);
const pDq = await post("/api/crm/leads", operator.cookie, {
  scope: "businesses",
  businessIds: [ids.dq],
  tiers: ["disqualified"],
});
check("tiers=[disqualified] is refused (400)", pDq.status === 400, String(pDq.status));
const manual = await post("/api/crm/leads", operator.cookie, {
  scope: "manual",
  businessId: ids.cold,
  priority: "low",
  note: "Met at the trade fair",
});
check("manual lead for the cold business (201)", manual.status === 201, String(manual.status));
const manualDq = await post("/api/crm/leads", operator.cookie, {
  scope: "manual",
  businessId: ids.dq,
});
check("manual lead for a disqualified business is 409", manualDq.status === 409);
const leadHot = p1.json?.created?.find((c) => c.businessId === ids.hot)?.leadId;
const leadWarm = p1.json?.created?.find((c) => c.businessId === ids.warm)?.leadId;

// 5. List filters and detail
const lHot = await get(
  `/api/crm/leads?tier=hot&q=${encodeURIComponent(String(stamp))}`,
  viewer.cookie,
);
check(
  "list filter tier=hot + q finds exactly the hot lead",
  lHot.status === 200 && lHot.json?.leads?.length === 1 && lHot.json.leads[0].id === leadHot,
  `${lHot.status} ${lHot.json?.leads?.length}`,
);
check("list pageSize is 50", lHot.json?.pageSize === 50);
check(
  "bad filter is 400",
  (await get("/api/crm/leads?stage=closed", viewer.cookie)).status === 400,
);
const d1 = await get(`/api/crm/leads/${leadHot}`, viewer.cookie);
check(
  "lead detail (200) with history, timeline and health",
  d1.status === 200 &&
    d1.json?.lead?.stageHistory?.length === 1 &&
    d1.json.lead.health === "active" &&
    d1.json.lead.version === 1,
);
check("viewer sees no allowed next stages", d1.json?.lead?.allowedNextStages?.length === 0);
check(
  "unknown lead is 404",
  (await get(`/api/crm/leads/${crypto.randomUUID()}`, viewer.cookie)).status === 404,
);
check("malformed id is 404", (await get(`/api/crm/leads/not-an-id`, viewer.cookie)).status === 404);

// 6. Optimistic concurrency
const u1 = await patch(`/api/crm/leads/${leadHot}`, operator.cookie, {
  version: 1,
  priority: "high",
  valueEstimatePaise: 2500000,
  nextFollowUpAt: "2024-01-01T10:00:00+05:30",
});
check(
  "PATCH with the current version (200, version 2)",
  u1.status === 200 && u1.json?.lead?.version === 2,
);
const u2 = await patch(`/api/crm/leads/${leadHot}`, admin.cookie, { version: 1, priority: "low" });
check(
  "PATCH with a stale version is 409 with currentVersion",
  u2.status === 409 && u2.json?.currentVersion === 2,
  `${u2.status} ${JSON.stringify(u2.json)}`,
);
check(
  "viewer PATCH is 403",
  (await patch(`/api/crm/leads/${leadHot}`, viewer.cookie, { version: 2, priority: "low" }))
    .status === 403,
);
const overdue = await get(`/api/crm/leads?overdue=yes&q=${stamp}`, viewer.cookie);
check(
  "past follow-up makes the lead overdue",
  overdue.json?.leads?.some((l) => l.id === leadHot && l.overdue === true),
);

// 7. Stage rules
let v = 2;
const stage = (cookie, body, id = leadHot) =>
  post(`/api/crm/leads/${id}/stage`, cookie, { version: v, ...body });
let s = await stage(operator.cookie, { to: "contacted", note: "Called the owner" });
check("new -> contacted (200)", s.status === 200 && s.json?.lead?.stage === "contacted");
v = s.json?.lead?.version ?? v;
s = await stage(operator.cookie, { to: "won" });
check("contacted -> won is not allowed (400)", s.status === 400, String(s.status));
s = await stage(operator.cookie, { to: "lost" });
check("lost without a reason is 400", s.status === 400 && /reason/.test(s.json?.error ?? ""));
s = await stage(operator.cookie, { to: "lost", lostReason: "Chose a relative's nephew" });
check("contacted -> lost with a reason (200)", s.status === 200 && s.json?.lead?.lostReason);
v = s.json?.lead?.version ?? v;
s = await stage(operator.cookie, { to: "nurture" });
check("operator cannot reopen a lost lead (403)", s.status === 403, String(s.status));
s = await stage(admin.cookie, { to: "negotiating" });
check("reopen only to nurture/contacted (400)", s.status === 400);
s = await stage(admin.cookie, { to: "nurture", note: "Budget next quarter" });
check(
  "admin reopens lost -> nurture (200, lost reason cleared)",
  s.status === 200 && s.json?.lead?.stage === "nurture" && s.json.lead.lostReason === null,
);
v = s.json?.lead?.version ?? v;
s = await stage(operator.cookie, { to: "contacted", version: 1 });
check("stage change with a stale version is 409", s.status === 409);

// 8. Assignment
const a1 = await post(`/api/crm/leads/${leadHot}/assign`, operator.cookie, {
  version: v,
  assigneeId: operatorU.id,
});
check(
  "assign to the operator (200)",
  a1.status === 200 && a1.json?.lead?.assigneeId === operatorU.id,
);
v = a1.json?.lead?.version ?? v;
const a2 = await post(`/api/crm/leads/${leadHot}/assign`, operator.cookie, {
  version: v,
  assigneeId: viewerU.id,
});
check("a viewer cannot be an assignee (400)", a2.status === 400);
const mine = await get(`/api/crm/leads?assignee=me`, operator.cookie);
check(
  "assignee=me lists the operator's lead",
  mine.json?.leads?.some((l) => l.id === leadHot),
);

// 9. Timeline and note editing
const n1 = await post(`/api/crm/leads/${leadHot}/activities`, operator.cookie, {
  type: "note",
  body: "Owner prefers WhatsApp after 6pm",
});
check("operator adds a note (201)", n1.status === 201);
const noteId = n1.json?.activity?.id;
check(
  "author edits the note within 15 minutes (200)",
  (
    await patch(`/api/crm/leads/${leadHot}/activities/${noteId}`, operator.cookie, {
      body: "Edited",
    })
  ).status === 200,
);
check(
  "another user cannot edit the note (403)",
  (await patch(`/api/crm/leads/${leadHot}/activities/${noteId}`, admin.cookie, { body: "x" }))
    .status === 403,
);
check(
  "system activity types cannot be added by hand (400)",
  (
    await post(`/api/crm/leads/${leadHot}/activities`, operator.cookie, {
      type: "system",
      body: "x",
    })
  ).status === 400,
);
const call1 = await post(`/api/crm/leads/${leadHot}/activities`, operator.cookie, {
  type: "call_logged",
  body: "Discussed a menu website",
});
check("call logged (201)", call1.status === 201);

// 10. Tasks
const tk = await post(`/api/crm/leads/${leadWarm}/tasks`, operator.cookie, {
  title: "Send sample sites",
  dueAt: "2024-01-02T09:00:00+05:30",
});
check(
  "task created (201, assigned to creator)",
  tk.status === 201 && tk.json?.task?.assigneeId === operatorU.id,
);
const od = await get(`/api/crm/leads?overdue=true&q=${stamp}`, viewer.cookie);
check(
  "open task past due makes the lead overdue",
  od.json?.leads?.some((l) => l.id === leadWarm && l.overdueTaskCount === 1),
);
const done = await patch(`/api/crm/leads/${leadWarm}/tasks/${tk.json?.task?.id}`, operator.cookie, {
  status: "done",
});
check("task done (200, completedAt set)", done.status === 200 && done.json?.task?.completedAt);
const tk2 = await post(`/api/crm/leads/${leadWarm}/tasks`, operator.cookie, { title: "Follow up" });
const cancelled = await del(
  `/api/crm/leads/${leadWarm}/tasks/${tk2.json?.task?.id}`,
  operator.cookie,
);
check("DELETE cancels a task (200)", cancelled.json?.task?.status === "cancelled");
const dWarm = await get(`/api/crm/leads/${leadWarm}`, viewer.cookie);
check(
  "task_done is on the timeline",
  dWarm.json?.lead?.activities?.some((a) => a.type === "task_done"),
);

// 11. Contacts
const c1 = await post(`/api/crm/leads/${leadWarm}/contacts`, operator.cookie, {
  personName: "Ravi Patil",
  role: "Owner",
  phone: "098450 12345",
});
check(
  "contact created, phone normalised, primary when first (201)",
  c1.status === 201 && c1.json?.contact?.phone === "+919845012345" && c1.json.contact.isPrimary,
);
const c2 = await post(`/api/crm/leads/${leadWarm}/contacts`, operator.cookie, {
  personName: "Asha",
  isPrimary: true,
});
check("second primary contact demotes the first", c2.status === 201);
const dC = await get(`/api/crm/leads/${leadWarm}`, viewer.cookie);
check(
  "exactly one primary contact",
  dC.json?.lead?.contacts?.filter((c) => c.isPrimary).length === 1,
);
check(
  "empty contact is 400",
  (await post(`/api/crm/leads/${leadWarm}/contacts`, operator.cookie, {})).status === 400,
);
check(
  "contact PATCH (200)",
  (
    await patch(`/api/crm/leads/${leadWarm}/contacts/${c1.json?.contact?.id}`, operator.cookie, {
      role: "Manager",
    })
  ).status === 200,
);
check(
  "contact DELETE (200)",
  (await del(`/api/crm/leads/${leadWarm}/contacts/${c2.json?.contact?.id}`, operator.cookie))
    .status === 200,
);

// 12. Tags
const tg = await put(`/api/crm/leads/${leadHot}/tags`, operator.cookie, {
  tags: [`E2E${stamp}`, `e2e${stamp}`, "Follow up"],
});
check(
  "tags are case-insensitively unique (2 tags)",
  tg.status === 200 && tg.json?.tags?.length === 2,
);
const byTag = await get(`/api/crm/leads?tag=E2E${stamp}`, viewer.cookie);
check("tag filter matches case-insensitively", byTag.json?.leads?.length === 1);
check(
  "bad tag is 400",
  (await put(`/api/crm/leads/${leadHot}/tags`, operator.cookie, { tags: ["=cmd()"] })).status ===
    400,
);

// 13. Do-not-contact
const dn = await post(`/api/crm/leads/${leadHot}/dnc`, operator.cookie, {
  status: "opted_out",
  reason: "Owner asked on the call not to be contacted",
  lawfulBasisNote: "Publicly listed business number; opted out 2026-11-26",
});
check(
  "operator marks opted-out (200)",
  dn.status === 200 && dn.json?.business?.contactStatus === "opted_out",
);
const cur = (await get(`/api/crm/leads/${leadHot}`, viewer.cookie)).json?.lead;
v = cur?.version ?? v;
s = await stage(operator.cookie, { to: "contacted" });
check(
  "opted-out lead cannot move to contacted (409)",
  s.status === 409 && s.json?.code === "do_not_contact",
);
check(
  "operator cannot clear DNC (403)",
  (await del(`/api/crm/leads/${leadHot}/dnc`, operator.cookie, { reason: "mistake" })).status ===
    403,
);

// 14. Export (before clearing DNC: channels must be blank)
check(
  "operator cannot export (403)",
  (await get(`/api/crm/leads/export?q=${stamp}`, operator.cookie)).status === 403,
);
const ex = await get(`/api/crm/leads/export?q=${stamp}`, admin.cookie);
const lines = ex.text.trim().split(/\r\n/);
const hotLine = lines.find((l) => l.includes(leadHot)) ?? "";
check(
  "admin export is CSV (200)",
  ex.status === 200 && ex.type.startsWith("text/csv") && lines[0].startsWith("lead_id,"),
);
check("export rows respect the filter (3 leads)", lines.length === 4, String(lines.length - 1));
check(
  "export is formula-injection safe",
  hotLine.includes(`"'=HYPERLINK(""x"")`),
  hotLine.slice(0, 120),
);
check("opted-out business has no phone in the export", !hotLine.includes("+919811100001"));
check(
  "clearing DNC needs admin and a reason",
  (await del(`/api/crm/leads/${leadHot}/dnc`, admin.cookie, {})).status === 400,
);
const clr = await del(`/api/crm/leads/${leadHot}/dnc`, admin.cookie, {
  reason: "Owner re-consented in writing",
});
check("admin clears DNC (200)", clr.status === 200 && clr.json?.business?.contactStatus === "ok");

// 15. Import
const csv = [
  "name,category,phone,email,postcode,lat,lon,contact_name,priority,tags,note",
  `Import ${stamp} New,clinics,98450${String(stamp).slice(-5)},,590010,15.86,74.51,Dr Rao,high,E2E${stamp},From referral`,
  `Import ${stamp} Warm dup,restaurants,+91 98111 00002,,,,,,,,`,
  `Import ${stamp} NoGeo,retail,,a${stamp}@example.org,,,,,,,`,
  `Bad,bakery,9845000000,,,,,,,,`,
].join("\n");
check(
  "operator cannot import (403)",
  (await post("/api/crm/leads/import", operator.cookie, csv, { "content-type": "text/csv" }))
    .status === 403,
);
const dry = await post("/api/crm/leads/import?dryRun=1", admin.cookie, csv, {
  "content-type": "text/csv",
});
check(
  "dry run validates without writing",
  dry.status === 200 &&
    dry.json?.dryRun === true &&
    dry.json.valid === 1 &&
    dry.json.created.length === 0,
  JSON.stringify(
    dry.json && { valid: dry.json.valid, errors: dry.json.errors, skipped: dry.json.skipped },
  ),
);
check(
  "dry run reports the existing lead, missing geo and bad category",
  dry.json?.skipped?.length === 1 && dry.json?.errors?.length === 2,
);
const imp = await post("/api/crm/leads/import", admin.cookie, { csv });
check(
  "import creates the new business + lead (201)",
  imp.status === 201 && imp.json?.created?.length === 1,
);
const imp2 = await post("/api/crm/leads/import", admin.cookie, { csv });
check("re-import is idempotent (0 created)", imp2.json?.created?.length === 0);
const impLead = imp.json?.created?.[0]?.leadId;
const impD = await get(`/api/crm/leads/${impLead}`, viewer.cookie);
check(
  "imported lead has source import, contact, tag and note",
  impD.json?.lead?.source === "import" &&
    impD.json.lead.contacts?.[0]?.personName === "Dr Rao" &&
    impD.json.lead.tags?.length === 1 &&
    impD.json.lead.activities?.some((a) => a.type === "note"),
);

// 16. Tags + assignees lists
check("tags list (200)", (await get("/api/crm/tags", viewer.cookie)).json?.tags?.length >= 2);
const asg = await get("/api/crm/assignees", viewer.cookie);
check(
  "assignees list excludes viewers",
  asg.status === 200 && !asg.json?.users?.some((u) => u.id === viewerU.id),
);

// 17. Audit
for (const action of [
  "crm.lead_promote",
  "crm.stage_change",
  "crm.assign",
  "crm.dnc_set",
  "crm.dnc_clear",
  "crm.lead_import",
  "crm.export",
])
  check(`audited ${action}`, (await auditCount(action, t0)) >= 1);

// 18. Admin UI pages (server-rendered, no-JS server-action forms)
const crmOp = await page(`/crm?q=${stamp}`, operator.cookie);
check(
  "operator /crm renders pipeline, filters and the lead rows",
  crmOp.status === 200 &&
    crmOp.html.includes('aria-label="Pipeline"') &&
    crmOp.html.includes('aria-label="Filter leads"') &&
    crmOp.html.includes(`data-lead="${leadWarm}"`) &&
    crmOp.html.includes(`/crm/leads/${leadHot}`),
  String(crmOp.status),
);
check(
  "operator /crm has no export link or import panel (admin only)",
  !crmOp.html.includes("/api/crm/leads/export") && !crmOp.html.includes("Import leads from CSV"),
);
const crmAdm = await page(`/crm?q=${stamp}&stage=new`, admin.cookie);
check(
  "admin /crm offers filtered CSV export and import",
  crmAdm.html.includes(`/api/crm/leads/export?stage=new&amp;q=${stamp}`) &&
    crmAdm.html.includes("Import leads from CSV"),
);
const crmView = await page(`/crm?q=${stamp}`, viewer.cookie);
check(
  "viewer reads /crm without forms",
  crmView.status === 200 &&
    crmView.html.includes(`data-lead="${leadWarm}"`) &&
    !crmView.html.includes("$ACTION_ID_") &&
    !crmView.html.includes("Import leads from CSV"),
);
check(
  "bad /crm filter shows a message instead of failing",
  (await page("/crm?stage=closed", viewer.cookie)).html.includes("Filters ignored"),
);
const detView = await page(`/crm/leads/${leadWarm}`, viewer.cookie);
check(
  "viewer reads the lead detail without forms",
  detView.status === 200 &&
    detView.html.includes("Timeline") &&
    detView.html.includes("Read only") &&
    !detView.html.includes("$ACTION_ID_") &&
    !detView.html.includes("<form"),
  String(detView.status),
);
check(
  "unknown lead page is 404",
  (await page(`/crm/leads/${crypto.randomUUID()}`, viewer.cookie)).status === 404,
);
const detOp = await page(`/crm/leads/${leadWarm}`, operator.cookie);
const warmNow = await one(`select stage, version from lead where id = $1`, [leadWarm]);
const stageForm = findForm(detOp.html, 'aria-label="Change stage"');
check(
  "operator detail renders stage, timeline, task, contact, tag and DNC forms",
  !!stageForm &&
    Object.keys(stageForm).some((k) => k.startsWith("$ACTION_ID_")) &&
    stageForm.version === String(warmNow.version) &&
    [
      "Add to timeline",
      "Add task",
      "Add contact",
      'aria-label="Tags"',
      "Mark do-not-contact",
    ].every((m) => detOp.html.includes(m)) &&
    detOp.html.includes(`/businesses/${ids.warm}`),
  warmNow && `${warmNow.stage} v${warmNow.version}`,
);
const uiT0 = new Date();
const target = warmNow.stage === "nurture" ? "interested" : "nurture";
const sub = await submitForm(`/crm/leads/${leadWarm}`, operator.cookie, {
  ...stageForm,
  to: target,
  note: `UI e2e ${stamp}`,
});
const warmAfter = await one(`select stage, version from lead where id = $1`, [leadWarm]);
check(
  "stage change via the form redirects with ok and saves",
  [303, 302, 307].includes(sub.status) &&
    sub.location.includes("ok=Stage changed") &&
    warmAfter.stage === target &&
    warmAfter.version === warmNow.version + 1,
  `${sub.status} ${sub.location.slice(0, 80)} ${warmAfter.stage}`,
);
const uiAudit = await one(
  `select metadata from audit_log where action = 'crm.stage_change' and "entityId" = $1 and "createdAt" >= $2 order by "createdAt" desc limit 1`,
  [leadWarm, uiT0],
);
check(
  "form stage change wrote a crm.stage_change audit row",
  uiAudit?.metadata?.to === target && uiAudit.metadata.from === warmNow.stage,
);
// The stage form above still carries the old version: submitting it again is a conflict.
const stale = await submitForm(`/crm/leads/${leadWarm}`, operator.cookie, {
  ...stageForm,
  to: target === "nurture" ? "interested" : "nurture",
});
check(
  "a stale form is refused with the 409 message",
  stale.location.includes("error=") && /changed by someone else/.test(stale.location),
  stale.location.slice(0, 120),
);
const conflictPage = await page(stale.location.replace(BASE, ""), operator.cookie);
check(
  "the detail page shows the 'changed by someone else, reload' banner",
  conflictPage.html.includes('data-testid="conflict"') &&
    conflictPage.html.includes("changed by someone else") &&
    conflictPage.html.includes(">Reload<"),
);
check(
  "stale form changed nothing",
  (await one(`select stage from lead where id = $1`, [leadWarm])).stage === target,
);
const lostForm = findForm(
  (await page(`/crm/leads/${leadWarm}`, operator.cookie)).html,
  'aria-label="Change stage"',
);
const lostNoReason = await submitForm(`/crm/leads/${leadWarm}`, operator.cookie, {
  ...lostForm,
  to: "lost",
});
check(
  "Lost via the form without a reason is refused",
  lostNoReason.location.includes("error=") && /reason/.test(lostNoReason.location),
);
const leadsOp = await page("/leads", operator.cookie);
const leadsView = await page("/leads", viewer.cookie);
check(
  "operator /leads has the Promote to CRM form (hot+warm default)",
  leadsOp.html.includes('aria-label="Promote to CRM"') &&
    /name="tiers" checked="" value="hot"/.test(leadsOp.html) &&
    /name="tiers" checked="" value="warm"/.test(leadsOp.html) &&
    /name="tiers" value="cold"/.test(leadsOp.html),
);
check("viewer /leads has no promote form", !leadsView.html.includes("Promote to CRM"));
const bizWarm = await page(`/businesses/${ids.warm}`, operator.cookie);
check(
  "business detail links to its CRM lead",
  bizWarm.html.includes(`/crm/leads/${leadWarm}`) && bizWarm.html.includes("Open lead in CRM"),
);
// "Add to CRM" from a business page (a fresh warm business with no lead)
const addId = crypto.randomUUID();
await db.query(
  `insert into business (id, name, "normalizedName", category, provider, "providerId", lat, lon,
     source, "sourceType", "sourceUrl", "collectedAt", "lastSeenAt", confidence, "latestTier",
     "latestScore", "qualifiedAt", "updatedAt")
   values ($1,$2,$3,'restaurants',$4,$5,15.85,74.5,'mock','mock',$6,now(),now(),0.5,'warm',55,now(),now())`,
  [
    addId,
    `E2E CRM ${stamp} add`,
    `e2e crm ${stamp} add`,
    PROVIDER,
    `${stamp}/add`,
    `https://example.org/${stamp}/add`,
  ],
);
const addForm = findForm(
  (await page(`/businesses/${addId}`, operator.cookie)).html,
  `value="${addId}"`,
  "Add to CRM",
);
const added = addForm
  ? await submitForm(`/businesses/${addId}`, operator.cookie, addForm)
  : { location: "" };
const addedLead = await one(`select id, source from lead where "businessId" = $1`, [addId]);
check(
  "Add to CRM on the business page creates a manual lead and returns there",
  added.location.includes(`/businesses/${addId}?ok=`) && addedLead?.source === "manual",
  added.location.slice(0, 100),
);
// DNC banner on a do-not-contact lead
const dncLeadId = addedLead?.id;
await post(`/api/crm/leads/${dncLeadId}/dnc`, operator.cookie, {
  status: "do_not_contact",
  reason: "UI e2e: asked not to be contacted",
});
const dncPage = await page(`/crm/leads/${dncLeadId}`, operator.cookie);
check(
  "DNC lead shows the banner and hides channels; operator cannot clear it",
  dncPage.html.includes('data-testid="dnc-banner"') &&
    !dncPage.html.includes('aria-label="Clear do-not-contact"'),
);
check(
  "admin sees the clear do-not-contact form",
  (await page(`/crm/leads/${dncLeadId}`, admin.cookie)).html.includes(
    'aria-label="Clear do-not-contact"',
  ),
);
check(
  "/crm marks the DNC lead with a badge",
  (await page(`/crm?q=${stamp}`, operator.cookie)).html.includes(">DNC<"),
);

// Cleanup: leads, history, timeline, tasks, contacts and tag links cascade from business.
await db.query(
  `delete from business where provider = $1 or (provider = 'csv-import' and name like $2)`,
  [PROVIDER, `Import ${stamp}%`],
);
await db.query(`delete from lead_tag where key like $1`, [`e2e${stamp}%`]);
await db.query(`update "user" set banned = true where id = any($1)`, [
  [viewerU.id, operatorU.id, adminU.id],
]);
await db.end();
console.log(failures ? `\n${failures} check(s) failed` : "\nAll CRM checks passed");
process.exit(failures ? 1 : 0);
