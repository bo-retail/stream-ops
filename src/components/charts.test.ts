import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DailyBars } from "./charts";

describe("DailyBars hover (Samuel 10/21: easier to catch)", () => {
  const html = renderToStaticMarkup(
    createElement(DailyBars, {
      points: [
        { dateISO: "2026-10-19", value: 1_533_050 },
        { dateISO: "2026-10-20", value: 904_700 },
      ],
      format: (v: number) => `$${(v / 100).toLocaleString("en-US")}`,
    }),
  );

  it("each day's whole column is a hover target with its own card", () => {
    expect(html.match(/group\/day/g)?.length).toBe(2);
    expect(html).toContain("group-hover/day:opacity-100");
  });

  it("the card names the day and its figure, with commas", () => {
    expect(html).toContain("$15,330.5");
    expect(html).toContain("$9,047");
  });

  it("no slow built-in tooltip is left on the bars", () => {
    expect(html).not.toContain("<title>");
  });
});
