// One-off helper: rewrites the documented project path after the folder moved.
import { readFileSync, writeFileSync } from "node:fs";

const OLD = String.raw`C:\Users\samue\OneDrive\Business Idea\Gypsy\stream-ops`;
const NEW = String.raw`C:\Users\samue\Downloads\STREAM\stream-ops`;

for (const file of ["QUICKSTART.md", "README.md"]) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    console.log(`skip (missing): ${file}`);
    continue;
  }
  const count = text.split(OLD).length - 1;
  if (count > 0) {
    writeFileSync(file, text.split(OLD).join(NEW), "utf8");
  }
  console.log(`${file}: replaced ${count} path(s)`);
}
