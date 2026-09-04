import "server-only";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { readSession } from "./session";
import type { Role, Team } from "@/generated/prisma/enums";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  /** Which side of the business. Shipping is never scheduled and never asked
   *  for availability, so most of the employee app does not apply to them. */
  team: Team;
  mustChangePassword: boolean;
}

/**
 * Resolves the signed-in user from the database, not from the token.
 *
 * This is the single place authorisation decisions start from. Reading the user
 * fresh means a deactivated account stops working on its next request instead of
 * lingering until its cookie expires.
 */
export async function getCurrentUser(): Promise<AuthUser | null> {
  const session = await readSession();
  if (!session) return null;

  const user = await prisma.user.findUnique({
    where: { id: session.id },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      team: true,
      isActive: true,
      mustChangePassword: true,
    },
  });
  if (!user || !user.isActive) return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    team: user.team,
    mustChangePassword: user.mustChangePassword,
  };
}

/** For pages: sends anyone not signed in to the login screen. */
export async function requireUser(): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  return user;
}

/** For boss-only pages. Employees are bounced to their own dashboard, not shown a 403. */
export async function requireBoss(): Promise<AuthUser> {
  const user = await requireUser();
  if (user.role !== "BOSS") redirect("/dashboard");
  return user;
}

/**
 * For pages only a streamer has any use for — availability and the schedule.
 *
 * Shipping has no schedule at all, so these are not merely empty for them, they
 * are misleading: an availability page implies somebody is waiting on an answer.
 */
export async function requireStreamer(): Promise<AuthUser> {
  const user = await requireUser();
  if (user.role !== "BOSS" && user.team !== "STREAMING") redirect("/dashboard");
  return user;
}

export class AuthorizationError extends Error {
  constructor(message = "You do not have access to that.") {
    super(message);
    this.name = "AuthorizationError";
  }
}

/**
 * For server actions and route handlers, where redirecting is the wrong response.
 * Throws instead, so a caller can turn it into a form error or a 403.
 */
export async function requireUserOrThrow(): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) throw new AuthorizationError("You are not signed in.");
  return user;
}

export async function requireBossOrThrow(): Promise<AuthUser> {
  const user = await requireUserOrThrow();
  if (user.role !== "BOSS") throw new AuthorizationError("Only an admin can do that.");
  return user;
}

/**
 * Guards employee-scoped reads. An employee may only ever request their own
 * records; the boss may request anyone's.
 */
export function assertCanViewEmployee(viewer: AuthUser, targetUserId: string): void {
  if (viewer.role === "BOSS") return;
  if (viewer.id !== targetUserId) {
    throw new AuthorizationError("You can only view your own records.");
  }
}
