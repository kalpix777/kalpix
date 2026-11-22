"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { canAssignRole, ROLES } from "@/lib/rbac";
import { recordAudit } from "../audit";
import { assertPermission } from "../session";
import { runAction } from "./util";

const PATH = "/users";

const createSchema = z.object({
  name: z.string().min(2).max(80),
  email: z.string().email(),
  password: z.string().min(12, "Password must be at least 12 characters").max(128),
  role: z.enum(ROLES),
});

export async function createTeamMember(formData: FormData) {
  await runAction(PATH, "Team member created. Share the temporary password securely.", async () => {
    const session = await assertPermission("users:manage");
    const data = createSchema.parse(Object.fromEntries(formData));
    if (!canAssignRole(session.user.role, data.role))
      throw new Error(`You cannot assign the ${data.role} role`);
    if (await db.user.findUnique({ where: { email: data.email } }))
      throw new Error("A user with that email already exists");
    const res = await auth.api.createUser({
      body: { email: data.email, password: data.password, name: data.name },
    });
    await db.user.update({ where: { id: res.user.id }, data: { role: data.role } });
    await recordAudit({
      actorId: session.user.id,
      actorLabel: session.user.email,
      action: "user.create",
      entityType: "user",
      entityId: res.user.id,
      metadata: { email: data.email, role: data.role },
    });
    revalidatePath(PATH);
  });
}

export async function changeRole(formData: FormData) {
  await runAction(PATH, "Role updated", async () => {
    const session = await assertPermission("users:manage");
    const { userId, role } = z
      .object({ userId: z.string(), role: z.enum(ROLES) })
      .parse(Object.fromEntries(formData));
    if (userId === session.user.id) throw new Error("You cannot change your own role");
    const target = await db.user.findUniqueOrThrow({ where: { id: userId } });
    if (
      !canAssignRole(session.user.role, role) ||
      (target.role === "owner" && session.user.role !== "owner")
    ) {
      throw new Error("You do not have permission to make this change");
    }
    if (
      target.role === "owner" &&
      role !== "owner" &&
      (await db.user.count({ where: { role: "owner" } })) <= 1
    ) {
      throw new Error("The platform must keep at least one owner");
    }
    await db.user.update({ where: { id: userId }, data: { role } });
    await recordAudit({
      actorId: session.user.id,
      actorLabel: session.user.email,
      action: "user.role_change",
      entityType: "user",
      entityId: userId,
      metadata: { from: target.role, to: role },
    });
    revalidatePath(PATH);
  });
}

export async function setSuspended(formData: FormData) {
  const suspend = formData.get("suspend") === "true";
  await runAction(
    PATH,
    suspend ? "Access suspended and sessions revoked" : "Access restored",
    async () => {
      const session = await assertPermission("users:manage");
      const userId = z.string().parse(formData.get("userId"));
      if (userId === session.user.id) throw new Error("You cannot suspend yourself");
      const target = await db.user.findUniqueOrThrow({ where: { id: userId } });
      if (target.role === "owner" && session.user.role !== "owner")
        throw new Error("Only an owner can suspend an owner");
      await db.user.update({
        where: { id: userId },
        data: { banned: suspend, banReason: suspend ? "Suspended by administrator" : null },
      });
      if (suspend) await db.session.deleteMany({ where: { userId } });
      await recordAudit({
        actorId: session.user.id,
        actorLabel: session.user.email,
        action: suspend ? "user.suspend" : "user.restore",
        entityType: "user",
        entityId: userId,
      });
      revalidatePath(PATH);
    },
  );
}
