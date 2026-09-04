/**
 * Applies pending migrations.
 *
 * Wraps `prisma migrate deploy` for one reason: Prisma takes a Postgres
 * advisory lock before applying anything, and against this Neon database that
 * lock reliably times out with P1002 — `migrate status` works, `migrate deploy`
 * does not. Disabling the lock makes it work instantly.
 *
 * The lock exists to stop two deploys applying migrations at the same time. That
 * risk is real on a team with automated deploys; it is not real here, where one
 * person runs this by hand. If this project ever migrates from CI, take the lock
 * back and solve the timeout properly instead.
 *
 * Deliberately NOT part of `npm run build`. A build that talks to the database
 * fails when the database hiccups, and a failed deploy over a transient network
 * blip is worse than remembering to run one command.
 *
 *   node scripts/migrate-deploy.mjs
 */
import { spawn } from "node:child_process";

const npx = process.platform === "win32" ? "npx.cmd" : "npx";

const child = spawn(npx, ["prisma", "migrate", "deploy"], {
  stdio: "inherit",
  env: { ...process.env, PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: "true" },
  shell: process.platform === "win32",
});

child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (error) => {
  console.error("Could not run prisma:", error.message);
  process.exit(1);
});
