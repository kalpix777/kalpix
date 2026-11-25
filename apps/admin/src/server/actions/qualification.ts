"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { recordAudit } from "../audit";
import {
  clearFactOverride,
  enqueueQualificationRun,
  overrideFactVerification,
  qualificationFormToInput,
} from "../qualification";
import { assertPermission } from "../session";
import { runAction } from "./util";

const PATH = "/leads";
const BUSINESS_PATH = /^\/businesses\/[0-9a-f-]{36}$/i;

function backPath(formData: FormData) {
  const back = String(formData.get("returnTo") ?? "");
  return BUSINESS_PATH.test(back) ? back : PATH;
}

export async function startQualificationRun(formData: FormData) {
  const raw = qualificationFormToInput(formData);
  const path = backPath(formData);
  await runAction(path, "Qualification run queued", async () => {
    const session = await assertPermission("qualification:run");
    const { created } = await enqueueQualificationRun(session.user, raw);
    if (!created) throw new Error("An identical qualification run is already queued or running");
    revalidatePath(PATH);
  });
}

const idSchema = z.string().uuid();

export async function retryQualificationRun(formData: FormData) {
  const id = idSchema.parse(formData.get("id"));
  await runAction(PATH, "Run re-queued; it resumes after the last qualified business", async () => {
    const session = await assertPermission("qualification:run");
    const r = await db.qualificationRun.updateMany({
      where: { id, status: { in: ["failed", "cancelled"] } },
      data: { status: "queued", error: null, finishedAt: null, attempts: 0, lockedBy: null },
    });
    if (r.count === 0) throw new Error("Only failed or cancelled runs can be retried");
    await recordAudit({
      actorId: session.user.id,
      actorLabel: session.user.email,
      action: "qualification.run_retry",
      entityType: "qualification_run",
      entityId: id,
    });
    revalidatePath(PATH);
  });
}

export async function cancelQualificationRun(formData: FormData) {
  const id = idSchema.parse(formData.get("id"));
  await runAction(PATH, "Run cancelled", async () => {
    const session = await assertPermission("qualification:run");
    const r = await db.qualificationRun.updateMany({
      where: { id, status: { in: ["queued", "running"] } },
      data: { status: "cancelled", finishedAt: new Date(), lockedBy: null },
    });
    if (r.count === 0) throw new Error("Only queued or running runs can be cancelled");
    await recordAudit({
      actorId: session.user.id,
      actorLabel: session.user.email,
      action: "qualification.run_cancel",
      entityType: "qualification_run",
      entityId: id,
    });
    revalidatePath(PATH);
  });
}

/** Manual verification override of one fact (operator+, reason required, audited). */
export async function overrideFact(formData: FormData) {
  const path = backPath(formData);
  await runAction(
    path,
    "Verification override saved. The score updates on the next qualification run.",
    async () => {
      const session = await assertPermission("facts:verify");
      await overrideFactVerification(session.user, {
        factId: String(formData.get("factId") ?? ""),
        status: String(formData.get("status") ?? ""),
        reason: String(formData.get("reason") ?? ""),
      });
      revalidatePath(path);
    },
  );
}

export async function clearOverride(formData: FormData) {
  const path = backPath(formData);
  await runAction(
    path,
    "Override removed. The next qualification run re-checks this fact automatically.",
    async () => {
      const session = await assertPermission("facts:verify");
      await clearFactOverride(session.user, {
        factId: String(formData.get("factId") ?? ""),
        reason: String(formData.get("reason") ?? "") || undefined,
      });
      revalidatePath(path);
    },
  );
}
