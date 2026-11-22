"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { canEnable } from "@kalpix/core";
import { db } from "@/lib/db";
import { secretStatus } from "@/lib/provider-registry";
import { toRole } from "@/lib/rbac";
import { recordAudit } from "../audit";
import { assertPermission } from "../session";
import { getSettings } from "../settings";
import { runAction } from "./util";

const PATH = "/providers";

export async function toggleProvider(formData: FormData) {
  const id = z.string().parse(formData.get("id"));
  const enable = formData.get("enable") === "true";
  await runAction(PATH, enable ? "Provider enabled" : "Provider disabled", async () => {
    const session = await assertPermission("providers:manage");
    const p = await db.providerConfig.findUniqueOrThrow({ where: { id } });
    if (enable) {
      const status = secretStatus(p.requiredSecrets);
      const check = canEnable(
        {
          id: p.id,
          name: p.name,
          category: p.category,
          costTier: p.costTier,
          requiredSecrets: p.requiredSecrets,
          commercialUseVerified: p.commercialUseVerified,
        },
        new Set(status.configured),
      );
      if (!check.ok) throw new Error(check.error);
      const settings = await getSettings();
      if (
        p.costTier !== "free" &&
        settings.approvals.paidProviderActivation &&
        toRole(session.user.role) !== "owner"
      ) {
        throw new Error("Only the owner can activate a paid or freemium provider");
      }
    }
    await db.providerConfig.update({ where: { id }, data: { enabled: enable } });
    await recordAudit({
      actorId: session.user.id,
      actorLabel: session.user.email,
      action: enable ? "provider.enable" : "provider.disable",
      entityType: "provider",
      entityId: id,
    });
    revalidatePath(PATH);
  });
}

export async function setCommercialVerified(formData: FormData) {
  const id = z.string().parse(formData.get("id"));
  const verified = formData.get("verified") === "true";
  await runAction(
    PATH,
    verified ? "Marked commercial terms as verified" : "Marked commercial terms as unverified",
    async () => {
      const session = await assertPermission("providers:manage");
      if (toRole(session.user.role) !== "owner")
        throw new Error("Only the owner can confirm commercial-use terms");
      await db.providerConfig.update({
        where: { id },
        data: { commercialUseVerified: verified, ...(verified ? {} : { enabled: false }) },
      });
      await recordAudit({
        actorId: session.user.id,
        actorLabel: session.user.email,
        action: "provider.commercial_terms",
        entityType: "provider",
        entityId: id,
        metadata: { verified },
      });
      revalidatePath(PATH);
    },
  );
}

const limitsSchema = z.object({
  id: z.string(),
  monthlyLimitUnits: z.coerce.number().int().min(0).max(10_000_000).optional(),
  monthlyBudget: z.coerce.number().min(0).max(10_000_000).optional(),
  fallbackProviderId: z.string().optional(),
});

export async function updateProviderLimits(formData: FormData) {
  const raw = Object.fromEntries([...formData.entries()].filter(([, v]) => v !== ""));
  await runAction(PATH, "Limits saved", async () => {
    const session = await assertPermission("providers:manage");
    const data = limitsSchema.parse(raw);
    if (data.fallbackProviderId === data.id)
      throw new Error("A provider cannot fall back to itself");
    await db.providerConfig.update({
      where: { id: data.id },
      data: {
        monthlyLimitUnits: data.monthlyLimitUnits ?? null,
        monthlyBudgetMinor:
          data.monthlyBudget !== undefined ? Math.round(data.monthlyBudget * 100) : null,
        fallbackProviderId: data.fallbackProviderId ?? null,
      },
    });
    await recordAudit({
      actorId: session.user.id,
      actorLabel: session.user.email,
      action: "provider.limits",
      entityType: "provider",
      entityId: data.id,
      metadata: { ...data },
    });
    revalidatePath(PATH);
  });
}
