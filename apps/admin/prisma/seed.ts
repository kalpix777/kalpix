// Idempotent seed: provider catalogue, default settings, DEMO service packages, first owner.
import { PrismaClient } from "@prisma/client";
import { PROVIDER_REGISTRY } from "../src/lib/provider-registry";

const db = new PrismaClient();

async function main() {
  for (const p of PROVIDER_REGISTRY) {
    await db.providerConfig.upsert({
      where: { id: p.id },
      update: {
        name: p.name,
        category: p.category,
        costTier: p.costTier,
        requiredSecrets: p.requiredSecrets,
        fallbackProviderId: p.fallbackProviderId ?? null,
      },
      create: {
        id: p.id,
        name: p.name,
        category: p.category,
        costTier: p.costTier,
        requiredSecrets: p.requiredSecrets,
        fallbackProviderId: p.fallbackProviderId ?? null,
        commercialUseVerified: p.commercialUseVerified,
        notes: p.notes,
        enabled: false,
      },
    });
  }

  await db.systemSetting.upsert({
    where: { key: "general" },
    update: {},
    create: {
      key: "general",
      value: {
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
      },
    },
  });

  // DEMO packages: placeholders so the screen is not empty. Prices are zero until the owner sets them.
  const demo = [
    {
      code: "DEMO-STARTER",
      name: "Starter website (DEMO)",
      category: "development",
      billingCycle: "one_time" as const,
    },
    {
      code: "DEMO-CARE",
      name: "Monthly care plan (DEMO)",
      category: "maintenance",
      billingCycle: "monthly" as const,
    },
  ];
  for (const d of demo) {
    await db.servicePackage.upsert({
      where: { code: d.code },
      update: {},
      create: { ...d, priceMinor: 0, isDemo: true, active: false },
    });
  }

  const email = process.env.SEED_OWNER_EMAIL;
  const password = process.env.SEED_OWNER_PASSWORD;
  if (email && password) {
    const existing = await db.user.findUnique({ where: { email } });
    if (!existing) {
      const { auth } = await import("../src/lib/auth");
      const res = await auth.api.createUser({
        body: { email, password, name: process.env.SEED_OWNER_NAME ?? "Owner" },
      });
      await db.user.update({ where: { id: res.user.id }, data: { role: "owner" } });
      await db.auditLog.create({
        data: {
          actorLabel: "system",
          action: "user.seed_owner",
          entityType: "user",
          entityId: res.user.id,
        },
      });
      console.log(`Owner created: ${email}. Sign in and enable MFA immediately.`);
    } else {
      console.log(`Owner already exists: ${email}`);
    }
  } else {
    console.log("SEED_OWNER_EMAIL / SEED_OWNER_PASSWORD not set: no owner created.");
  }
  console.log(
    `Seeded ${PROVIDER_REGISTRY.length} providers (all disabled), settings, ${demo.length} DEMO packages.`,
  );
}

main().finally(() => db.$disconnect());
