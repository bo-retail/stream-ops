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

export type MemberChange =
  | { error: string }
  | { list: string[]; add: string[] };

/**
 * What saving the "Who it goes to" list would do, or why it must not.
 *
 * Before the schedule is published the list is whatever the boss ticks:
 * `list` is the whole new list, saved as a replacement. After, it can only
 * grow. A new account made mid-release — somebody's login replaced, a new hire
 * — has to be offered in the seat picker, and adding a name changes nothing
 * anyone is already on. Taking a name off a schedule people are working to is
 * a different matter, so once published a name the page did not send is left
 * as it is: only `add` is saved. That also means a second admin's page, opened
 * before somebody else added a name, cannot take that name back off.
 *
 * `current` is the saved list. `streamerIds` is every active streamer — a member
 * whose account has since been deactivated has no tick box, so a page that
 * still carries their id is not asking to add them.
 */
export function planMemberChange(input: {
  published: boolean;
  current: readonly string[];
  wanted: readonly string[];
  streamerIds: readonly string[];
}): MemberChange {
  const streamers = new Set(input.streamerIds);
  const current = new Set(input.current);

  const asked = [...new Set(input.wanted)].filter((id) => !(current.has(id) && !streamers.has(id)));
  if (asked.some((id) => !streamers.has(id))) {
    return { error: "Only active streamers can be put on a release." };
  }
  if (asked.length === 0) return { error: "Pick at least one person." };

  const add = asked.filter((id) => !current.has(id));
  if (!input.published) return { list: asked, add };

  if (current.size === 0) {
    // Made before a release could be aimed: it already offers every streamer,
    // and saving a fixed list now would only narrow it.
    return {
      error: "This release already includes the whole team, so there is nobody to add.",
    };
  }
  return { list: [...current, ...add], add };
}
