"use server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { recordAudit } from "../audit";
import { assertPermission } from "../session";
import { getSettings, settingsSchema } from "../settings";
import { runAction } from "./util";

export async function updateSettings(formData: FormData) {
  await runAction("/settings", "Settings saved", async () => {
    const session = await assertPermission("settings:write");
    const before = await getSettings();
    const next = settingsSchema.parse({
      agencyName: formData.get("agencyName"),
      defaultCurrency: formData.get("defaultCurrency"),
      timezone: formData.get("timezone"),
      pilotMarket: formData.get("pilotMarket"),
      approvals: {
        outboundMessages: formData.get("outboundMessages") === "on",
        financialActions: formData.get("financialActions") === "on",
        productionChanges: formData.get("productionChanges") === "on",
        paidProviderActivation: formData.get("paidProviderActivation") === "on",
      },
    });
    const loosened = Object.entries(next.approvals).some(
      ([k, v]) => !v && before.approvals[k as keyof typeof before.approvals],
    );
    if (loosened && session.user.role !== "owner")
      throw new Error("Only the owner can turn off an approval requirement");
    await db.systemSetting.upsert({
      where: { key: "general" },
      update: { value: next, updatedBy: session.user.id },
      create: { key: "general", value: next, updatedBy: session.user.id },
    });
    await recordAudit({
      actorId: session.user.id,
      actorLabel: session.user.email,
      action: "settings.update",
      entityType: "setting",
      entityId: "general",
      metadata: { before, after: next },
    });
    revalidatePath("/settings");
  });
}
