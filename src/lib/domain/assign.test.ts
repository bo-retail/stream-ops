import { describe, expect, it } from "vitest";
import { ALL_RULES_OFF, blockerFor, rankCandidates, shareUsed } from "./assign";
import type { Candidate, PersonContext, Rules, SeatContext } from "./assign";

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    userId: over.name ?? "someone",
    name: "Someone",
    priority: 0,
    offered: 10,
    assigned: 0,
    ...over,
  };
}

/** Both optional rules on, which is what the old fixed order used to be. */
const BOTH: Rules = { usePriority: true, useProportional: true };

const order = (candidates: Candidate[], rules: Rules = BOTH) =>
  rankCandidates(candidates, rules).map((c) => c.name);

describe("priority people go first", () => {
  it("puts a priority person ahead of everyone else", () => {
    expect(
      order([
        candidate({ name: "Ana", priority: 0 }),
        candidate({ name: "Ben", priority: 10 }),
        candidate({ name: "Cara", priority: 0 }),
      ]),
    ).toEqual(["Ben", "Ana", "Cara"]);
  });

  it("ranks higher priority above lower", () => {
    expect(
      order([
        candidate({ name: "Ana", priority: 1 }),
        candidate({ name: "Ben", priority: 5 }),
        candidate({ name: "Cara", priority: 3 }),
      ]),
    ).toEqual(["Ben", "Cara", "Ana"]);
  });

  it("outranks availability", () => {
    // Ana is wide open and has nothing; Ben is nearly full and barely
    // available. Priority still wins.
    expect(
      order([
        candidate({ name: "Ana", priority: 0, offered: 30, assigned: 0 }),
        candidate({ name: "Ben", priority: 1, offered: 4, assigned: 3 }),
      ]),
    ).toEqual(["Ben", "Ana"]);
  });
});

describe("more availability gets more work", () => {
  it("puts whoever has used least of their own availability first", () => {
    expect(
      order([
        candidate({ name: "Ana", offered: 10, assigned: 6 }), // 60%
        candidate({ name: "Ben", offered: 30, assigned: 3 }), // 10%
        candidate({ name: "Cara", offered: 8, assigned: 2 }), // 25%
      ]),
    ).toEqual(["Ben", "Cara", "Ana"]);
  });

  it("ranks the more available person first when both have the same shows", () => {
    expect(
      order([
        candidate({ name: "Ana", offered: 6, assigned: 2 }),
        candidate({ name: "Ben", offered: 30, assigned: 2 }),
      ]),
    ).toEqual(["Ben", "Ana"]);
  });

  it("does not let the most available person take everything", () => {
    // The part-timer is well behind on shows but has used more of what they
    // offered, so the full-timer keeps going — which is the point.
    expect(
      order([
        candidate({ name: "Full", offered: 30, assigned: 8 }), // 27%
        candidate({ name: "Part", offered: 6, assigned: 3 }), // 50%
      ]),
    ).toEqual(["Full", "Part"]);
    // …until the full-timer is proportionally ahead, when it swings back.
    expect(
      order([
        candidate({ name: "Full", offered: 30, assigned: 20 }), // 67%
        candidate({ name: "Part", offered: 6, assigned: 3 }), // 50%
      ]),
    ).toEqual(["Part", "Full"]);
  });

  it("hands the work out in proportion to availability over a whole period", () => {
    // The rule the boss signed off on: offer three times as much, get roughly
    // three times the work. Simulated seat by seat, exactly as the scheduler
    // does it.
    const people = [
      { userId: "maya", name: "Maya", priority: 0, offered: 30, assigned: 0 },
      { userId: "sam", name: "Sam", priority: 0, offered: 10, assigned: 0 },
    ];
    for (let seatsLeft = 20; seatsLeft > 0; seatsLeft--) {
      rankCandidates(people, BOTH)[0].assigned += 1;
    }
    expect(people.map((p) => [p.name, p.assigned])).toEqual([
      ["Maya", 15],
      ["Sam", 5],
    ]);
  });

  it("never starves somebody who offered only a little", () => {
    const people = [
      { userId: "full", name: "Full", priority: 0, offered: 28, assigned: 0 },
      { userId: "part", name: "Part", priority: 0, offered: 4, assigned: 0 },
    ];
    for (let seatsLeft = 16; seatsLeft > 0; seatsLeft--) {
      rankCandidates(people, BOTH)[0].assigned += 1;
    }
    expect(people.find((p) => p.name === "Part")!.assigned).toBeGreaterThan(0);
  });

  it("measures the share of availability used", () => {
    expect(shareUsed(candidate({ offered: 10, assigned: 5 }))).toBe(0.5);
    expect(shareUsed(candidate({ offered: 30, assigned: 0 }))).toBe(0);
    // Nothing offered means nothing left to give, so they sort last.
    expect(shareUsed(candidate({ offered: 0, assigned: 0 }))).toBe(1);
  });
});

describe("spreading the work", () => {
  it("gives the seat to whoever has fewest, all else equal", () => {
    expect(
      order([
        candidate({ name: "Ana", assigned: 4, offered: 40 }),
        candidate({ name: "Ben", assigned: 1, offered: 10 }),
        candidate({ name: "Cara", assigned: 3, offered: 30 }),
      ]),
    ).toEqual(["Ben", "Cara", "Ana"]);
  });

  it("breaks a complete tie on name, so rebuilds are stable", () => {
    const people = [
      candidate({ name: "Cara" }),
      candidate({ name: "Ana" }),
      candidate({ name: "Ben" }),
    ];
    expect(order(people)).toEqual(["Ana", "Ben", "Cara"]);
    // Same input in a different order must give the same result.
    expect(order([...people].reverse())).toEqual(["Ana", "Ben", "Cara"]);
  });

  it("does not modify the array it was given", () => {
    const people = [candidate({ name: "Cara" }), candidate({ name: "Ana" })];
    rankCandidates(people, BOTH);
    expect(people.map((p) => p.name)).toEqual(["Cara", "Ana"]);
  });
});

describe("the whole order together", () => {
  it("applies priority, then availability, then spread", () => {
    expect(
      order([
        candidate({ name: "Even", priority: 0, offered: 10, assigned: 2 }), // 20%
        candidate({ name: "Keen", priority: 0, offered: 30, assigned: 1 }), // 3%
        candidate({ name: "Key", priority: 5, offered: 10, assigned: 8 }), // priority
        candidate({ name: "Done", priority: 0, offered: 5, assigned: 4 }), // 80%
      ]),
    ).toEqual(["Key", "Keen", "Even", "Done"]);
  });
});

describe("the rules are switches, set per release", () => {
  const people = () => [
    candidate({ name: "Ana", priority: 0, offered: 30, assigned: 4 }), // 13%
    candidate({ name: "Ben", priority: 9, offered: 10, assigned: 6 }), // 60%, priority
    candidate({ name: "Cara", priority: 0, offered: 10, assigned: 2 }), // 20%
  ];

  it("ignores priority when the release did not ask for it", () => {
    const on = order(people(), { usePriority: true, useProportional: true });
    const off = order(people(), { usePriority: false, useProportional: true });
    expect(on[0]).toBe("Ben");
    // Without the priority rule Ben is simply the person who has used most of
    // his availability, so he goes last.
    expect(off).toEqual(["Ana", "Cara", "Ben"]);
  });

  it("ignores availability share when the release did not ask for it", () => {
    // Off, rule 4 decides: fewest shows so far. Cara has 2, Ana 4, Ben 6.
    expect(order(people(), { usePriority: false, useProportional: false })).toEqual([
      "Cara",
      "Ana",
      "Ben",
    ]);
  });

  it("still fills the seat with both switches off", () => {
    // Rules 1 and 4 are not switches: somebody has to get the seat, and the
    // fairest answer left is whoever has least, then name.
    const flat = [
      candidate({ name: "Cara", priority: 0, offered: 4, assigned: 1 }),
      candidate({ name: "Ana", priority: 0, offered: 40, assigned: 1 }),
    ];
    expect(order(flat, ALL_RULES_OFF)).toEqual(["Ana", "Cara"]);
  });

  it("gives an even spread when proportional is off", () => {
    const evenly = [
      { userId: "maya", name: "Maya", priority: 0, offered: 30, assigned: 0 },
      { userId: "sam", name: "Sam", priority: 0, offered: 10, assigned: 0 },
    ];
    for (let seatsLeft = 20; seatsLeft > 0; seatsLeft--) {
      rankCandidates(evenly, ALL_RULES_OFF)[0].assigned += 1;
    }
    // Same 20 seats that split 15/5 when proportional is on.
    expect(evenly.map((p) => [p.name, p.assigned])).toEqual([
      ["Maya", 10],
      ["Sam", 10],
    ]);
  });
});

/* --------------------------------------------------------------- blockers */

function seat(over: Partial<SeatContext> = {}): SeatContext {
  return {
    dateISO: "2026-09-03",
    startsAt: new Date("2026-09-03T17:00:00Z"),
    endsAt: new Date("2026-09-03T23:00:00Z"),
    onThisShow: new Set(),
    placed: [],
    ...over,
  };
}

function person(over: Partial<PersonContext> = {}): PersonContext {
  return {
    userId: "ana",
    offeredThisShow: true,
    daysOff: [],
    assigned: 0,
    maxShows: null,
    ...over,
  };
}

describe("who is blocked from a seat", () => {
  it("lets through somebody who offered and is free", () => {
    expect(blockerFor(person(), seat())).toBeNull();
  });

  it("blocks somebody who did not offer the show", () => {
    // The rule that matters most: never assign somebody who is not available.
    expect(blockerFor(person({ offeredThisShow: false }), seat())?.code).toBe("NOT_OFFERED");
  });

  it("blocks somebody who booked the day off", () => {
    expect(blockerFor(person({ daysOff: ["2026-09-03"] }), seat())?.code).toBe("DAY_OFF");
  });

  it("blocks somebody already on this show", () => {
    expect(blockerFor(person(), seat({ onThisShow: new Set(["ana"]) }))?.code).toBe(
      "ALREADY_ON_SHOW",
    );
  });

  it("blocks somebody on an overlapping show", () => {
    const blocker = blockerFor(
      person(),
      seat({
        placed: [
          {
            userId: "ana",
            startsAt: new Date("2026-09-03T20:00:00Z"),
            endsAt: new Date("2026-09-04T02:00:00Z"),
          },
        ],
      }),
    );
    expect(blocker?.code).toBe("CLASH");
  });

  it("allows a show that merely touches another end to end", () => {
    const blocker = blockerFor(
      person(),
      seat({
        placed: [
          {
            userId: "ana",
            startsAt: new Date("2026-09-03T11:00:00Z"),
            endsAt: new Date("2026-09-03T17:00:00Z"),
          },
        ],
      }),
    );
    expect(blocker).toBeNull();
  });

  it("ignores somebody else's clashing show", () => {
    const blocker = blockerFor(
      person({ userId: "ana" }),
      seat({
        placed: [
          {
            userId: "ben",
            startsAt: new Date("2026-09-03T20:00:00Z"),
            endsAt: new Date("2026-09-04T02:00:00Z"),
          },
        ],
      }),
    );
    expect(blocker).toBeNull();
  });

  it("blocks somebody at their weekly limit", () => {
    expect(blockerFor(person({ assigned: 6, maxShows: 6 }), seat())?.code).toBe("AT_LIMIT");
  });

  it("allows somebody below the limit", () => {
    expect(blockerFor(person({ assigned: 5, maxShows: 6 }), seat())).toBeNull();
  });

  it("ignores a limit of none or zero", () => {
    expect(blockerFor(person({ assigned: 99, maxShows: null }), seat())).toBeNull();
    expect(blockerFor(person({ assigned: 99, maxShows: 0 }), seat())).toBeNull();
  });

  it("reports being on the show before anything else", () => {
    // Somebody in the show's other seat should be told that, not "did not offer".
    const blocker = blockerFor(
      person({ offeredThisShow: false }),
      seat({ onThisShow: new Set(["ana"]) }),
    );
    expect(blocker?.code).toBe("ALREADY_ON_SHOW");
  });
});
