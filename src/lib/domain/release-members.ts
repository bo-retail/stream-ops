/**
 * Who a release is for.
 *
 * The boss picks the people when they build a release. That list is the whole
 * point of picking it: a diamond release goes to the two people who work
 * diamonds and nobody else, and a watch release does not land on their page at
 * all. Anything that asks "should this person see this release" asks here.
 *
 * Pure, like everything under `src/lib/domain` — the ids come from the caller.
 * That is deliberate: the same rule then governs the page that lists somebody's
 * requests and the action that saves their answer, and the two cannot drift
 * into disagreeing about who was asked.
 */

/**
 * Whether this person was asked.
 *
 * An empty list means everybody, and that is not a placeholder. Every release
 * built before there was a list genuinely did go to the whole team, and reading
 * an empty list that way is what lets those keep working untouched. A release
 * made from now on cannot be sent until somebody is chosen, so an empty list
 * only ever means "made before we chose".
 */
export function isOnRelease(memberIds: readonly string[], userId: string): boolean {
  if (memberIds.length === 0) return true;
  return memberIds.includes(userId);
}

/**
 * How many people this release was sent to — the denominator of "12 of 14
 * answered".
 *
 * Counting every streamer instead is what made a diamond release read "0 of 17"
 * and stay there: fifteen of those seventeen were never asked, so the number
 * could not be reached and the boss had no way to see the request was complete.
 *
 * `teamSize` is the fallback for the empty list, for the same reason as above.
 */
export function askedCount(memberIds: readonly string[], teamSize: number): number {
  return memberIds.length === 0 ? teamSize : memberIds.length;
}
