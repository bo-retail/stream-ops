import { describe, expect, it } from "vitest";
import { askedCount, isOnRelease, planMemberChange } from "./release-members";

describe("isOnRelease", () => {
  it("asks the people on the list", () => {
    expect(isOnRelease(["aalyah", "agustina"], "aalyah")).toBe(true);
    expect(isOnRelease(["aalyah", "agustina"], "agustina")).toBe(true);
  });

  /*
    The bug this file exists for. A diamond release went to two people and
    every streamer was asked to fill it in, because the list the boss picked
    was read by the seat picker and by nothing else.
  */
  it("does not ask anybody else", () => {
    expect(isOnRelease(["aalyah", "agustina"], "andrea")).toBe(false);
    expect(isOnRelease(["aalyah", "agustina"], "daniella")).toBe(false);
  });

  it("asks everybody when nobody was chosen, for the releases built before there was a list", () => {
    expect(isOnRelease([], "anybody-at-all")).toBe(true);
  });

  it("does not match a prefix of an id", () => {
    expect(isOnRelease(["aalyah"], "aal")).toBe(false);
    expect(isOnRelease(["aalyah"], "aalyah2")).toBe(false);
  });
});

describe("askedCount", () => {
  it("counts the people it was sent to, not the team", () => {
    expect(askedCount(["aalyah", "agustina"], 17)).toBe(2);
  });

  it("counts the team when nobody was chosen", () => {
    expect(askedCount([], 17)).toBe(17);
  });

  it("is reachable — a release everyone answered reads as complete", () => {
    const members = ["aalyah", "agustina"];
    const answered = members.filter((id) => isOnRelease(members, id)).length;
    expect(answered).toBe(askedCount(members, 17));
  });
});

describe("planMemberChange", () => {
  const team = ["aalyah", "andrea", "charlene", "gideon", "marylene"];
  const onIt = ["aalyah", "andrea", "gideon", "marylene"];
  const plan = (published: boolean, current: string[], wanted: string[], streamerIds = team) =>
    planMemberChange({ published, current, wanted, streamerIds });

  // The case this was written for: Charlene's login was replaced after the
  // release was published, and the new account could not be ticked.
  it("adds a new account to a published release", () => {
    expect(plan(true, onIt, [...onIt, "charlene"])).toEqual({
      list: [...onIt, "charlene"],
      add: ["charlene"],
    });
  });

  // Once published, a name the page did not send is left on — never taken off.
  it("never takes anybody off a published release", () => {
    const r = plan(true, onIt, ["aalyah", "charlene"]);
    expect(r).toEqual({ list: [...onIt, "charlene"], add: ["charlene"] });
  });

  // Two admins: B added Dana while A's page was open. A adding Charlene must
  // work, and must not take Dana back off.
  it("a second admin's older page adds without undoing the first admin's add", () => {
    const team2 = [...team, "dana"];
    expect(plan(true, ["aalyah", "andrea", "dana"], ["aalyah", "andrea", "charlene"], team2)).toEqual({
      list: ["aalyah", "andrea", "dana", "charlene"],
      add: ["charlene"],
    });
  });

  it("saving a published release with nothing new adds nothing", () => {
    expect(plan(true, onIt, onIt)).toEqual({ list: onIt, add: [] });
  });

  // Marylene's old account deactivated and Charlene's new one made. The old
  // id has no tick box any more; an older page may still send it.
  it("replaces a deactivated login on a published release, whether or not the old id is sent", () => {
    const stillTeam = team.filter((id) => id !== "marylene");
    expect(plan(true, onIt, ["aalyah", "andrea", "gideon", "charlene"], stillTeam)).toEqual({
      list: [...onIt, "charlene"],
      add: ["charlene"],
    });
    expect(plan(true, onIt, [...onIt, "charlene"], stillTeam)).toEqual({
      list: [...onIt, "charlene"],
      add: ["charlene"],
    });
  });

  it("the only member deactivated, then the replacement added", () => {
    expect(plan(true, ["marylene"], ["charlene"], ["charlene"])).toEqual({
      list: ["marylene", "charlene"],
      add: ["charlene"],
    });
  });

  it("a draft drops a deactivated member, as it always did", () => {
    const stillTeam = team.filter((id) => id !== "marylene");
    expect(plan(false, onIt, ["aalyah"], stillTeam)).toEqual({ list: ["aalyah"], add: [] });
    expect(plan(false, onIt, onIt, stillTeam)).toEqual({ list: ["aalyah", "andrea", "gideon"], add: [] });
  });

  it("refuses somebody who is not an active streamer", () => {
    expect(plan(false, [], ["betsy"])).toHaveProperty("error");
    expect(plan(true, onIt, [...onIt, "betsy"])).toHaveProperty("error");
  });

  it("refuses an empty list, which would read as everybody", () => {
    expect(plan(false, onIt, [])).toHaveProperty("error");
    expect(plan(true, onIt, [])).toHaveProperty("error");
  });

  // Built before releases had a list: it already offers everyone, including a
  // brand-new account, and saving a fixed list would only narrow it.
  it("leaves a published whole-team release alone", () => {
    expect(plan(true, [], team)).toHaveProperty("error");
  });

  it("a draft saves exactly what is ticked, as before", () => {
    expect(plan(false, onIt, ["aalyah", "charlene"])).toEqual({
      list: ["aalyah", "charlene"],
      add: ["charlene"],
    });
  });

  it("the same name sent twice is added once", () => {
    expect(plan(true, onIt, [...onIt, "charlene", "charlene"])).toEqual({
      list: [...onIt, "charlene"],
      add: ["charlene"],
    });
  });
});
