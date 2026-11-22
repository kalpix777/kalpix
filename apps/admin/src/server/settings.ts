import "server-only";
import { z } from "zod";
import { db } from "@/lib/db";

export const settingsSchema = z.object({
  agencyName: z.string().min(2).max(80),
  defaultCurrency: z.enum(["INR", "USD", "EUR", "GBP", "AED"]),
  timezone: z.string().min(3).max(64),
  pilotMarket: z.string().min(2).max(120),
  approvals: z.object({
    outboundMessages: z.boolean(),
    financialActions: z.boolean(),
    productionChanges: z.boolean(),
    paidProviderActivation: z.boolean(),
  }),
});
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  agencyName: "Kalpix",
  defaultCurrency: "INR",
  timezone: "Asia/Kolkata",
  pilotMarket: "Belagavi, Karnataka, India",
  approvals: {
    outboundMessages: true,
    financialActions: true,
    productionChanges: true,
    paidProviderActivation: true,
  },
};

export async function getSettings(): Promise<Settings> {
  const row = await db.systemSetting.findUnique({ where: { key: "general" } });
  const parsed = settingsSchema.safeParse(row?.value);
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}
