import "server-only";
import { cache } from "react";
import { prisma } from "@/lib/db";

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: "EMPLOYEE" | "BOSS";
  isActive: boolean;
  team: "STREAMING" | "SHIPPING";
}

const SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  isActive: true,
  team: true,
} as const;

/**
 * Active streamers — everyone who can be scheduled onto a show.
 *
 * Shipping is excluded here rather than filtered at each call site: they have no
 * schedule at all, and one forgotten filter would put them in the picker, in the
 * "availability in" count, and in the auto-fill candidate list.
 */
export const listStreamers = cache(async (): Promise<TeamMember[]> => {
  return prisma.user.findMany({
    where: { isActive: true, role: "EMPLOYEE", team: "STREAMING" },
    orderBy: [{ name: "asc" }],
    select: SELECT,
  });
});

/** Everyone, including admins and deactivated accounts, for the Team screen. */
export const listAllUsers = cache(async (): Promise<TeamMember[]> => {
  return prisma.user.findMany({
    orderBy: [{ isActive: "desc" }, { role: "asc" }, { name: "asc" }],
    select: SELECT,
  });
});

/**
 * Name lookup covering deactivated people too — a historical schedule or a
 * payroll export must still render a name for someone who has since left.
 */
export const getUserNameMap = cache(async (): Promise<Record<string, string>> => {
  const users = await prisma.user.findMany({ select: { id: true, name: true } });
  return Object.fromEntries(users.map((u) => [u.id, u.name]));
});
