"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { recordAudit } from "../audit";
import { enqueueDiscoveryRun } from "../discovery";
import { assertPermission } from "../session";
import { runAction } from "./util";

const PATH = "/discovery";

export async function startDiscoveryRun(formData: FormData) {
  const raw = {
    area: String(formData.get("area") ?? ""),
    categories: formData.getAll("categories").map(String),
    provider: String(formData.get("provider") ?? "") || undefined,
    idempotencyKey: String(formData.get("idempotencyKey") ?? "") || undefined,
  };
  await runAction(PATH, "Discovery run queued", async () => {
    const session = await assertPermission("discovery:run");
    await enqueueDiscoveryRun(session.user, raw);
    revalidatePath(PATH);
  });
}

const idSchema = z.string().uuid();

export async function retryDiscoveryRun(formData: FormData) {
  const id = idSchema.parse(formData.get("id"));
  await runAction(PATH, "Run re-queued; it resumes from the last completed category", async () => {
    const session = await assertPermission("discovery:run");
    const r = await db.discoveryRun.updateMany({
      where: { id, status: { in: ["failed", "cancelled"] } },
      data: { status: "queued", error: null, finishedAt: null, attempts: 0, lockedBy: null },
    });
    if (r.count === 0) throw new Error("Only failed or cancelled runs can be retried");
    await recordAudit({
      actorId: session.user.id,
      actorLabel: session.user.email,
      action: "discovery.run_retry",
      entityType: "discovery_run",
      entityId: id,
    });
    revalidatePath(PATH);
  });
}

export async function cancelDiscoveryRun(formData: FormData) {
  const id = idSchema.parse(formData.get("id"));
  await runAction(PATH, "Run cancelled", async () => {
    const session = await assertPermission("discovery:run");
    const r = await db.discoveryRun.updateMany({
      where: { id, status: { in: ["queued", "running"] } },
      data: { status: "cancelled", finishedAt: new Date(), lockedBy: null },
    });
    if (r.count === 0) throw new Error("Only queued or running runs can be cancelled");
    await recordAudit({
      actorId: session.user.id,
      actorLabel: session.user.email,
      action: "discovery.run_cancel",
      entityType: "discovery_run",
      entityId: id,
    });
    revalidatePath(PATH);
  });
}
