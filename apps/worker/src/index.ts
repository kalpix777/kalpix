// Kalpix background worker. Processes the DB-backed job queues: discovery (Phase 3), website
// research (Phase 4) and verification + qualification (Phase 5), each a table claimed with
// FOR UPDATE SKIP LOCKED.
//   pnpm worker          poll forever (WORKER_POLL_INTERVAL_MS, default 5000)
//   pnpm worker:once     drain the queue once and exit (CI, cron)
import os from "node:os";
import { PrismaClient } from "@prisma/client";
import {
  resolveDiscoveryKind,
  resolveQualificationAiKind,
  resolveResearchKind,
} from "@kalpix/providers";
import { drainQueue } from "./process-run";
import { drainQualificationQueue } from "./qualification-run";
import { drainResearchQueue } from "./research-run";

const db = new PrismaClient();
const workerId = `${os.hostname()}:${process.pid}`;
const once = process.argv.includes("--once");
const interval = Math.max(1000, Number(process.env.WORKER_POLL_INTERVAL_MS) || 5000);
const log = (m: string) => console.log(`[worker ${new Date().toISOString()}] ${m}`);

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    log(`${sig} received, finishing current run then exiting`);
    stopping = true;
  });

async function main() {
  // Validates DISCOVERY_PROVIDER / RESEARCH_PROVIDER / QUALIFICATION_AI_PROVIDER early (all refuse
  // mock in production).
  log(
    `starting (${once ? "once" : "poll"}; discovery ${resolveDiscoveryKind(process.env)}, research ${resolveResearchKind(process.env)}, qualification AI ${resolveQualificationAiKind(process.env)})`,
  );
  do {
    const n = await drainQueue(db, workerId, { log });
    if (n) log(`processed ${n} discovery run(s)`);
    if (stopping) break;
    const r = await drainResearchQueue(db, workerId, { log });
    if (r) log(`processed ${r} research run(s)`);
    if (stopping) break;
    const q = await drainQualificationQueue(db, workerId, { log });
    if (q) log(`processed ${q} qualification run(s)`);
    if (once || stopping) break;
    await new Promise((r) => setTimeout(r, interval));
  } while (!stopping);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
