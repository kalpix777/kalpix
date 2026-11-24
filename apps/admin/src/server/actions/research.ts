"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { recordAudit } from "../audit";
import { enqueueResearchRun, researchFormToInput } from "../research";
import { assertPermission } from "../session";
import { runAction } from "./util";

const PATH = "/research";

export async function startResearchRun(formData: FormData) {
  const raw = researchFormToInput(formData);
  // "Research this business" on the detail page returns there; the research page otherwise.
  const back = String(formData.get("returnTo") ?? "");
  const path = /^\/businesses\/[0-9a-f-]{36}$/i.test(back) ? back : PATH;
  await runAction(path, "Research run queued", async () => {
    const session = await assertPermission("research:run");
    const { created } = await enqueueResearchRun(session.user, raw);
    if (!created) throw new Error("An identical research run is already queued or running");
    revalidatePath(PATH);
  });
}

const idSchema = z.string().uuid();

export async function retryResearchRun(formData: FormData) {
  const id = idSchema.parse(formData.get("id"));
  await runAction(
    PATH,
    "Run re-queued; it resumes after the last researched business",
    async () => {
      const session = await assertPermission("research:run");
      const r = await db.researchRun.updateMany({
        where: { id, status: { in: ["failed", "cancelled"] } },
        data: { status: "queued", error: null, finishedAt: null, attempts: 0, lockedBy: null },
      });
      if (r.count === 0) throw new Error("Only failed or cancelled runs can be retried");
      await recordAudit({
        actorId: session.user.id,
        actorLabel: session.user.email,
        action: "research.run_retry",
        entityType: "research_run",
        entityId: id,
      });
      revalidatePath(PATH);
    },
  );
}

export async function cancelResearchRun(formData: FormData) {
  const id = idSchema.parse(formData.get("id"));
  await runAction(PATH, "Run cancelled", async () => {
    const session = await assertPermission("research:run");
    const r = await db.researchRun.updateMany({
      where: { id, status: { in: ["queued", "running"] } },
      data: { status: "cancelled", finishedAt: new Date(), lockedBy: null },
    });
    if (r.count === 0) throw new Error("Only queued or running runs can be cancelled");
    await recordAudit({
      actorId: session.user.id,
      actorLabel: session.user.email,
      action: "research.run_cancel",
      entityType: "research_run",
      entityId: id,
    });
    revalidatePath(PATH);
  });
}
