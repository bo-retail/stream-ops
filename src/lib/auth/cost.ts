/**
 * Whether this person may see what a watch costs us — and so margins, cost of
 * goods and the Invicta master. Admins only (Samuel, 21 October): the shipping
 * director runs stock but does not see cost.
 *
 * Kept apart from `guards`, which pulls in Next's navigation, so scripts and
 * tests can use the same rule.
 */
export function canSeeCost(user: { role: string }): boolean {
  return user.role === "BOSS";
}
