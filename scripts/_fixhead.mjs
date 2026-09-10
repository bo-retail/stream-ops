import { readFileSync, writeFileSync } from "node:fs";

const path = "scripts/check-payroll.mts";
let text = readFileSync(path, "utf8");

// Anything before the opening comment is a leftover encoding artefact.
const start = text.indexOf("/**");
if (start > 0) {
  console.log(
    `stripped ${start} stray char(s): ` +
      [...text.slice(0, start)].map((c) => "U+" + c.codePointAt(0).toString(16).toUpperCase()).join(" "),
  );
  text = text.slice(start);
}

const stale = ` * The unit tests cover the arithmetic. This covers the join, which is where the
 * money actually goes wrong: hours live on the timesheet, sales live in an
 * upload, and what connects them is the shift tag on a listing — not the show
 * the watch sold in. Getting that backwards pays the wrong team, and every
 * figure still looks plausible.`;

const fresh = ` * The unit tests cover the arithmetic. This covers the join, which is where the
 * money actually goes wrong: hours live on the timesheet, sales live in an
 * upload, and what connects them is the show a watch sold in — not the shift
 * tag on the listing, which says only which show it was prepared for. Getting
 * that backwards pays the wrong team, and every figure still looks plausible.`;

if (text.includes(stale)) {
  text = text.replace(stale, fresh);
  console.log("header updated to the rule that is actually in force");
} else {
  console.log("header paragraph not found — check by hand");
}

writeFileSync(path, text, "utf8");
