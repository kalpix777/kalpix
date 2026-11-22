"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { recordAudit } from "../audit";
import { assertPermission } from "../session";
import { runAction } from "./util";

const PATH = "/sales";
const schema = z.object({
  code: z.string().regex(/^[A-Z0-9-]{3,32}$/, "Code: 3-32 chars, A-Z, 0-9 and dashes"),
  name: z.string().min(2).max(120),
  category: z.enum([
    "development",
    "redesign",
    "hosting",
    "maintenance",
    "seo",
    "content",
    "automation",
    "support",
  ]),
  billingCycle: z.enum(["one_time", "monthly", "yearly"]),
  price: z.coerce.number().min(0).max(100_000_000),
  currency: z.enum(["INR", "USD", "EUR", "GBP", "AED"]),
  taxRatePercent: z.coerce.number().min(0).max(50),
  description: z.string().max(500).optional(),
});

export async function createPackage(formData: FormData) {
  await runAction(PATH, "Package created", async () => {
    const session = await assertPermission("pricing:manage");
    const d = schema.parse(Object.fromEntries([...formData.entries()].filter(([, v]) => v !== "")));
    const pkg = await db.servicePackage.create({
      data: {
        code: d.code,
        name: d.name,
        category: d.category,
        billingCycle: d.billingCycle,
        priceMinor: Math.round(d.price * 100),
        currency: d.currency,
        taxRateBps: Math.round(d.taxRatePercent * 100),
        description: d.description,
      },
    });
    await recordAudit({
      actorId: session.user.id,
      actorLabel: session.user.email,
      action: "pricing.package_create",
      entityType: "service_package",
      entityId: pkg.id,
      metadata: { code: d.code, price: d.price, currency: d.currency },
    });
    revalidatePath(PATH);
  });
}

export async function togglePackage(formData: FormData) {
  const active = formData.get("active") === "true";
  await runAction(PATH, active ? "Package activated" : "Package deactivated", async () => {
    const session = await assertPermission("pricing:manage");
    const id = z.string().parse(formData.get("id"));
    const pkg = await db.servicePackage.findUniqueOrThrow({ where: { id } });
    if (active && pkg.isDemo)
      throw new Error("DEMO packages cannot be activated. Create a real package instead.");
    await db.servicePackage.update({ where: { id }, data: { active } });
    await recordAudit({
      actorId: session.user.id,
      actorLabel: session.user.email,
      action: active ? "pricing.package_activate" : "pricing.package_deactivate",
      entityType: "service_package",
      entityId: id,
    });
    revalidatePath(PATH);
  });
}
