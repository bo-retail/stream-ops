"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireBossOrThrow } from "@/lib/auth/guards";
import { generateTemporaryPassword, hashPassword } from "@/lib/auth/password";
import { prisma } from "@/lib/db";
import { POSITION_LABEL, fieldsToPosition, positionToFields } from "./position";
import type { Position } from "./position";

export interface TeamState {
  error?: string;
  ok?: string;
  /** Shown once, immediately after creation or a reset. Never stored in plain text. */
  temporaryPassword?: { name: string; email: string; password: string };
}

const CreateSchema = z.object({
  name: z.string().trim().min(2, "Enter the person's name.").max(120),
  email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address.")).and(z.string().max(200)),
  position: z.enum(["STREAMER", "SHIPPING", "ADMIN"]),
});

export async function createTeamMember(_prev: TeamState, formData: FormData): Promise<TeamState> {
  let boss;
  try {
    boss = await requireBossOrThrow();
  } catch {
    return { error: "Only an admin can add people." };
  }

  const parsed = CreateSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    position: formData.get("position") ?? "STREAMER",
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const { name, email, position } = parsed.data;
  const { role, team } = positionToFields(position);

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) return { error: "Someone already has that email address." };

  const password = generateTemporaryPassword();
  const user = await prisma.user.create({
    data: {
      name,
      team,
      email,
      role,
      passwordHash: await hashPassword(password),
      mustChangePassword: true,
    },
    select: { id: true },
  });

  await prisma.auditLog.create({
    data: {
      entityType: "User",
      entityId: user.id,
      action: "CREATE",
      actorId: boss.id,
      summary: `Created a ${position.toLowerCase()} account for ${name} (${email})`,
    },
  });

  revalidatePath("/admin/team");
  return {
    ok: `${name} can now sign in.`,
    temporaryPassword: { name, email, password },
  };
}

export async function setUserActive(userId: string, isActive: boolean): Promise<TeamState> {
  let boss;
  try {
    boss = await requireBossOrThrow();
  } catch {
    return { error: "Only an admin can do that." };
  }

  if (userId === boss.id && !isActive) {
    return { error: "You cannot deactivate your own account." };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, role: true },
  });
  if (!user) return { error: "That person no longer exists." };

  if (!isActive && user.role === "BOSS" && (await countActiveBosses()) <= 1) {
    return { error: "That is the only active admin. Promote someone else first." };
  }

  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { isActive } }),
    prisma.auditLog.create({
      data: {
        entityType: "User",
        entityId: userId,
        action: isActive ? "REACTIVATE" : "DEACTIVATE",
        actorId: boss.id,
        summary: `${isActive ? "Reactivated" : "Deactivated"} ${user.name}`,
      },
    }),
  ]);

  revalidatePath("/admin/team");
  revalidatePath("/admin/schedule");
  return { ok: `${user.name} ${isActive ? "reactivated" : "deactivated"}.` };
}

export async function setUserPosition(userId: string, position: Position): Promise<TeamState> {
  let boss;
  try {
    boss = await requireBossOrThrow();
  } catch {
    return { error: "Only an admin can do that." };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, role: true, team: true },
  });
  if (!user) return { error: "That person no longer exists." };

  const current = fieldsToPosition(user.role, user.team);
  if (current === position) return {};

  if (current === "ADMIN" && position !== "ADMIN" && (await countActiveBosses()) <= 1) {
    return { error: "That is the only active admin. Promote someone else first." };
  }

  const fields = positionToFields(position);

  // Moving to shipping takes somebody out of the scheduler. Their existing
  // assignments are left alone rather than deleted — deleting them would
  // silently empty seats on a published schedule — so the boss is told.
  const upcoming =
    position === "SHIPPING"
      ? await prisma.assignment.count({
          where: { userId, show: { status: "SCHEDULED", startsAt: { gte: new Date() } } },
        })
      : 0;

  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: fields }),
    // Priority is chosen per release now, so there is no standing setting to
    // clear. What must not survive is a release still being planned that names
    // somebody who has just stopped being a streamer.
    ...(position === "STREAMER"
      ? []
      : [
          prisma.releasePriority.deleteMany({
            where: { userId, release: { scheduleStatus: "DRAFT" } },
          }),
        ]),
    prisma.auditLog.create({
      data: {
        entityType: "User",
        entityId: userId,
        action: "SET_POSITION",
        actorId: boss.id,
        summary: `${user.name}: ${current.toLowerCase()} → ${position.toLowerCase()}${
          upcoming > 0 ? ` (${upcoming} upcoming show(s) left in place)` : ""
        }`,
        before: { role: user.role, team: user.team },
        after: fields,
      },
    }),
  ]);

  revalidatePath("/admin/team");
  revalidatePath("/admin/schedule");
  revalidatePath("/admin/settings");

  if (position === "SHIPPING" && upcoming > 0) {
    return {
      ok: `${user.name} is on shipping now. They are still on ${upcoming} upcoming show(s) — take them off the schedule if that is wrong.`,
    };
  }
  return { ok: `${user.name} is now ${POSITION_LABEL[position]}.` };
}

export async function resetUserPassword(userId: string): Promise<TeamState> {
  let boss;
  try {
    boss = await requireBossOrThrow();
  } catch {
    return { error: "Only an admin can do that." };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, email: true },
  });
  if (!user) return { error: "That person no longer exists." };

  const password = generateTemporaryPassword();
  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(password), mustChangePassword: true },
    }),
    prisma.auditLog.create({
      data: {
        entityType: "User",
        entityId: userId,
        action: "PASSWORD_RESET",
        actorId: boss.id,
        summary: `Reset the password for ${user.name}`,
      },
    }),
  ]);

  revalidatePath("/admin/team");
  return {
    ok: `Temporary password created for ${user.name}.`,
    temporaryPassword: { name: user.name, email: user.email, password },
  };
}

function countActiveBosses(): Promise<number> {
  return prisma.user.count({ where: { role: "BOSS", isActive: true } });
}
