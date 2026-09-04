"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/guards";
import { hashPassword, validatePassword, verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

export interface ChangePasswordState {
  error?: string;
}

const Schema = z.object({
  currentPassword: z.string().min(1, "Enter your current password."),
  newPassword: z.string().min(1, "Enter a new password."),
  confirmPassword: z.string().min(1, "Confirm your new password."),
});

export async function changePassword(
  _prev: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  const user = await getCurrentUser();
  if (!user) return { error: "You are not signed in." };

  const parsed = Schema.safeParse({
    currentPassword: formData.get("currentPassword"),
    newPassword: formData.get("newPassword"),
    confirmPassword: formData.get("confirmPassword"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const { currentPassword, newPassword, confirmPassword } = parsed.data;
  if (newPassword !== confirmPassword) return { error: "The two new passwords do not match." };

  const invalid = validatePassword(newPassword);
  if (invalid) return { error: invalid };

  const record = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { passwordHash: true },
  });
  if (!(await verifyPassword(currentPassword, record.passwordHash))) {
    return { error: "Your current password is incorrect." };
  }
  if (await verifyPassword(newPassword, record.passwordHash)) {
    return { error: "Choose a password you have not used here before." };
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(newPassword), mustChangePassword: false },
  });
  await prisma.auditLog.create({
    data: {
      entityType: "User",
      entityId: user.id,
      action: "PASSWORD_CHANGE",
      actorId: user.id,
      summary: `${user.name} changed their own password`,
    },
  });

  // Reissue the cookie so the session reflects the cleared must-change flag.
  await createSession({ id: user.id, email: user.email, name: user.name, role: user.role });
  redirect("/dashboard");
}
