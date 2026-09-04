/**
 * What somebody is: a streamer, on shipping, or an admin.
 *
 * One choice, not two. Underneath there is a role (who may do what) and a team
 * (which side of the business), but presenting those separately let somebody be
 * a "streamer on the shipping team", which is not a thing. This keeps the two in
 * step so the impossible combination cannot be entered.
 *
 * Kept out of actions.ts because a "use server" module may only export async
 * functions, and both the form and the table need these synchronously.
 */
export type Position = "STREAMER" | "SHIPPING" | "ADMIN";

export const POSITION_LABEL: Record<Position, string> = {
  STREAMER: "a streamer",
  SHIPPING: "on shipping",
  ADMIN: "an admin",
};

/** How a position maps onto the two columns that store it. */
export function positionToFields(position: Position): {
  role: "EMPLOYEE" | "BOSS";
  team: "STREAMING" | "SHIPPING";
} {
  if (position === "ADMIN") return { role: "BOSS", team: "STREAMING" };
  if (position === "SHIPPING") return { role: "EMPLOYEE", team: "SHIPPING" };
  return { role: "EMPLOYEE", team: "STREAMING" };
}

/** And back again, for rendering. */
export function fieldsToPosition(role: string, team: string): Position {
  if (role === "BOSS") return "ADMIN";
  return team === "SHIPPING" ? "SHIPPING" : "STREAMER";
}
