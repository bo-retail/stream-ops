/**
 * Turns a demo database into a real one.
 *
 * Creates your real admin account, then removes every demo account and all the
 * fake schedule data that came with them. Business settings are kept.
 *
 * The order matters: the real admin is created and verified *before* anything is
 * deleted, so a failure half way through can never leave you locked out.
 *
 *   node scripts/go-live.mjs --email you@yourbusiness.com --name "Your Name"
 *   node scripts/go-live.mjs --email you@yourbusiness.com --name "Your Name" --confirm
 *
 * Without --confirm it only reports what it would do.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { Client } from "pg";

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1];
}

const email = (arg("--email") ?? "").trim().toLowerCase();
const name = (arg("--name") ?? "").trim();
const confirmed = process.argv.includes("--confirm");

if (!email || !name) {
  console.error(
    'Usage: node scripts/go-live.mjs --email you@yourbusiness.com --name "Your Name" [--confirm]',
  );
  process.exit(1);
}
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error(`"${email}" is not a valid email address.`);
  process.exit(1);
}
if (email.endsWith("@streamops.local")) {
  console.error("That is a demo address. Use your real email.");
  process.exit(1);
}

/** Readable but strong: 4 words' worth of entropy in base64url. */
function temporaryPassword() {
  return randomBytes(12).toString("base64url");
}

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const { rows: demoUsers } = await db.query(
  `select id, email, role from "User" where email like '%@streamops.local'`,
);
const { rows: realUsers } = await db.query(
  `select id, email, role, "isActive" from "User" where email not like '%@streamops.local'`,
);
const { rows: counts } = await db.query(`
  select
    (select count(*)::int from "ScheduleWeek") as weeks,
    (select count(*)::int from "Show") as shows,
    (select count(*)::int from "Assignment") as assignments,
    (select count(*)::int from "Availability") as availability,
    (select count(*)::int from "TimeOff") as time_off
`);

console.log("\nWhat is in the database now:");
console.log(`  ${demoUsers.length} demo account(s) (…@streamops.local)`);
console.log(`  ${realUsers.length} real account(s)`);
console.log(
  `  ${counts[0].weeks} week(s), ${counts[0].shows} shows, ${counts[0].assignments} assignments, ` +
    `${counts[0].availability} availability rows, ${counts[0].time_off} days off`,
);

const existing = realUsers.find((u) => u.email === email);

console.log("\nWhat this will do:");
console.log(
  existing
    ? `  KEEP    ${email} — already exists, will be made an active admin`
    : `  CREATE  ${email} as admin "${name}", with a temporary password`,
);
console.log(`  DELETE  ${demoUsers.length} demo account(s)`);
console.log(`  DELETE  every week, show, assignment, availability row and day off`);
console.log(`  KEEP    your business settings (time zone, show hours)`);
console.log(`  KEEP    the audit log`);

if (!confirmed) {
  console.log("\nNothing has been changed. Re-run with --confirm to do it.");
  await db.end();
  process.exit(0);
}

const password = temporaryPassword();
const passwordHash = await bcrypt.hash(password, 12);

await db.query("begin");
try {
  // 1. The real admin first. If anything below fails, you can still sign in.
  if (existing) {
    await db.query(
      `update "User" set role = 'BOSS', "isActive" = true, name = $2, "updatedAt" = now()
       where id = $1`,
      [existing.id, name],
    );
  } else {
    await db.query(
      `insert into "User" (id, email, name, "passwordHash", role, "isActive", "mustChangePassword", "createdAt", "updatedAt")
       values (gen_random_uuid()::text, $1, $2, $3, 'BOSS', true, true, now(), now())`,
      [email, name, passwordHash],
    );
  }

  // 2. Verify the admin is really there before deleting anything.
  const { rows: check } = await db.query(
    `select count(*)::int as n from "User" where email = $1 and role = 'BOSS' and "isActive"`,
    [email],
  );
  if (check[0].n !== 1) throw new Error("the admin account was not created — nothing deleted");

  // 3. Now the demo data. Assignments, availability and time off cascade from
  //    the user rows; weeks cascade to shows and those to assignments.
  await db.query(`delete from "ScheduleWeek"`);
  await db.query(`delete from "Availability"`);
  await db.query(`delete from "AvailabilitySubmission"`);
  await db.query(`delete from "TimeOff"`);
  const { rowCount: removed } = await db.query(
    `delete from "User" where email like '%@streamops.local'`,
  );

  await db.query(
    `insert into "AuditLog" (id, "entityType", "entityId", action, summary, "createdAt")
     values (gen_random_uuid()::text, 'System', 'go-live', 'GO_LIVE', $1, now())`,
    [`Cleared ${removed} demo accounts and all demo schedule data; ${email} is the admin`],
  );

  await db.query("commit");

  console.log(`\nDone. Removed ${removed} demo account(s) and all demo schedule data.`);
  if (!existing) {
    console.log("\n  Sign in with:");
    console.log(`    Email:    ${email}`);
    console.log(`    Password: ${password}`);
    console.log("\n  You will be asked to set your own password immediately.");
    console.log("  This is the only time it is shown. Copy it now.");
  } else {
    console.log(`\n  ${email} is now the admin. Your existing password still works.`);
  }
  console.log("\nNext: sign in, then add your streamers from the Team page.");
} catch (error) {
  await db.query("rollback");
  console.error("\nFailed — nothing was changed.");
  console.error(error.message);
  await db.end();
  process.exit(1);
}

await db.end();
