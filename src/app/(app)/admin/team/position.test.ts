import { describe, expect, it } from "vitest";
import {
  POSITION_LABEL,
  POSITIONS,
  canBeScheduled,
  fieldsToPosition,
  positionName,
  positionToFields,
} from "./position";
import type { Position } from "./position";

const ALL: Position[] = ["STREAMER", "SHIPPING", "SHIPPING_DIRECTOR", "ADMIN"];

describe("a position and the two columns behind it", () => {
  it("round-trips every position", () => {
    // The pair exist to keep role and team in step. If a position cannot survive
    // the trip, somebody's row on the Team page shows the wrong thing.
    for (const position of ALL) {
      const fields = positionToFields(position);
      expect(fieldsToPosition(fields.role, fields.team)).toBe(position);
    }
  });

  it("puts the shipping director on the shipping side without making them an admin", () => {
    // The whole reason for a third role: requireBoss tests for BOSS exactly, so
    // this keeps her out of every admin page with no change to that guard.
    expect(positionToFields("SHIPPING_DIRECTOR")).toEqual({ role: "MANAGER", team: "SHIPPING" });
  });

  it("keeps a packer an ordinary employee", () => {
    expect(positionToFields("SHIPPING")).toEqual({ role: "EMPLOYEE", team: "SHIPPING" });
  });

  it("reads a manager as the shipping director whatever the team column says", () => {
    // MANAGER is only ever written alongside SHIPPING. Showing a drifted row as
    // a streamer would hide the problem instead of showing it.
    expect(fieldsToPosition("MANAGER", "SHIPPING")).toBe("SHIPPING_DIRECTOR");
    expect(fieldsToPosition("MANAGER", "STREAMING")).toBe("SHIPPING_DIRECTOR");
  });
});

describe("who goes on a show", () => {
  it("is only the streamer", () => {
    // Admins run the schedule and the shipping side has none; both are excluded
    // from the picker, the auto-fill and the availability chase.
    expect(canBeScheduled("STREAMER")).toBe(true);
    expect(canBeScheduled("SHIPPING")).toBe(false);
    expect(canBeScheduled("SHIPPING_DIRECTOR")).toBe(false);
    expect(canBeScheduled("ADMIN")).toBe(false);
  });

  it("excludes the shipping director from the streamer query's shape", () => {
    // listStreamers filters on role EMPLOYEE and team STREAMING. The director
    // matches neither, so she can never be scheduled onto a show by accident.
    const fields = positionToFields("SHIPPING_DIRECTOR");
    expect(fields.role === "EMPLOYEE" && fields.team === "STREAMING").toBe(false);
  });
});

describe("the labels", () => {
  it("offers every position in the picker", () => {
    // Two hand-written lists were one edit away from offering a position on the
    // add form and not on the row selector.
    expect(POSITIONS.map((p) => p.value).sort()).toEqual([...ALL].sort());
  });

  it("has a sentence form and a plain name for each", () => {
    for (const position of ALL) {
      expect(POSITION_LABEL[position]).toBeTruthy();
      expect(positionName(position)).toBeTruthy();
    }
  });

  it("reads as a sentence", () => {
    expect(`Ana is now ${POSITION_LABEL.SHIPPING_DIRECTOR}.`).toBe(
      "Ana is now the shipping director.",
    );
  });
});
