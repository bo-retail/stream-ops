import { describe, expect, it } from "vitest";
import { askedCount, isOnRelease } from "./release-members";

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
