/**
 * What somebody is: a streamer, a packer, the shipping director, or an admin.
 *
 * One choice, not two. Underneath there is a role (who may do what) and a team
 * (which side of the business), but presenting those separately let somebody be
 * a "streamer on the shipping team", which is not a thing. This keeps the two in
 * step so the impossible combination cannot be entered.
 *
 * Kept out of actions.ts because a "use server" module may only export async
 * functions, and both the form and the table need these synchronously.
 */
import type { Role, Team } from "@/generated/prisma/enums";

export type Position = "STREAMER" | "SHIPPING" | "SHIPPING_DIRECTOR" | "ADMIN";

/**
 * The list the pickers are built from.
 *
 * One source, used by both the add form and the per-row selector — they were
 * two hand-written lists, which is one edit away from offering a position on
 * one screen and not the other.
 */
export const POSITIONS: readonly { value: Position; label: string }[] = [
  { value: "STREAMER", label: "Streamer" },
  { value: "SHIPPING", label: "Shipping & packer" },
  { value: "SHIPPING_DIRECTOR", label: "Shipping director" },
  { value: "ADMIN", label: "Admin" },
];

/** The plain name, for a log line: "Ana: Streamer → Shipping director". */
export function positionName(position: Position): string {
  return POSITIONS.find((p) => p.value === position)?.label ?? position;
}

/** How the position reads inside a sentence: "Ana is now on shipping." */
export const POSITION_LABEL: Record<Position, string> = {
  STREAMER: "a streamer",
  SHIPPING: "on shipping",
  SHIPPING_DIRECTOR: "the shipping director",
  ADMIN: "an admin",
};

/**
 * Only streamers are put on shows.
 *
 * Admins and the shipping director are both excluded, for different reasons —
 * one runs the schedule, the other has no schedule at all — but the question
 * every caller actually asks is this one.
 */
export function canBeScheduled(position: Position): boolean {
  return position === "STREAMER";
}

/** How a position maps onto the two columns that store it. */
export function positionToFields(position: Position): { role: Role; team: Team } {
  switch (position) {
    case "ADMIN":
      return { role: "BOSS", team: "STREAMING" };
    case "SHIPPING_DIRECTOR":
      return { role: "MANAGER", team: "SHIPPING" };
    case "SHIPPING":
      return { role: "EMPLOYEE", team: "SHIPPING" };
    default:
      return { role: "EMPLOYEE", team: "STREAMING" };
  }
}

/**
 * And back again, for rendering.
 *
 * MANAGER maps straight to the shipping director without also testing the team:
 * it is the only manager the app defines, and a row showing somebody as a
 * streamer because their team column drifted would hide the problem rather than
 * show it.
 */
export function fieldsToPosition(role: string, team: string): Position {
  if (role === "BOSS") return "ADMIN";
  if (role === "MANAGER") return "SHIPPING_DIRECTOR";
  return team === "SHIPPING" ? "SHIPPING" : "STREAMER";
}
