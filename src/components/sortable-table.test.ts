import { describe, expect, it } from "vitest";
import { sortRows } from "./sortable-table";

const row = (key: string, ...sort: (number | string | null)[]) => ({ key, sort });
const keys = (rows: { key: string }[]) => rows.map((r) => r.key);

describe("sortRows (Samuel 10/21: click a heading, like Excel)", () => {
  const rows = [row("a", "70271", 4_333, 0.57), row("b", "35687", 2_895, 0.5), row("c", "49888", 9_000, null)];

  it("highest first, then lowest first", () => {
    expect(keys(sortRows(rows, 1, true))).toEqual(["c", "a", "b"]);
    expect(keys(sortRows(rows, 1, false))).toEqual(["b", "a", "c"]);
  });

  it("a blank stays at the bottom either way", () => {
    expect(keys(sortRows(rows, 2, true))).toEqual(["a", "b", "c"]);
    expect(keys(sortRows(rows, 2, false))).toEqual(["b", "a", "c"]);
  });

  it("words sort as words", () => {
    expect(keys(sortRows(rows, 0, false))).toEqual(["b", "c", "a"]);
  });

  it("negative numbers sort below zero", () => {
    expect(keys(sortRows([row("x", -500), row("y", 0), row("z", 200)], 0, true))).toEqual(["z", "y", "x"]);
  });

  it("no column chosen keeps the order given", () => {
    expect(keys(sortRows(rows, null, true))).toEqual(["a", "b", "c"]);
  });
});

describe("model numbers sort like numbers (review 10/21)", () => {
  it("9937 before 100123, as in Excel", () => {
    expect(keys(sortRows([row("big", "100123"), row("small", "9937")], 0, false))).toEqual(["small", "big"]);
  });
});
