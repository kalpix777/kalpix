import "server-only";
import { headers } from "next/headers";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export async function recordAudit(entry: {
  actorId?: string | null;
  actorLabel: string;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Prisma.InputJsonValue;
}) {
  let ipAddress: string | undefined;
  try {
    const h = await headers();
    ipAddress = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined;
  } catch {
    // outside a request (seed scripts)
  }
  await db.auditLog.create({ data: { ...entry, actorId: entry.actorId ?? null, ipAddress } });
}
