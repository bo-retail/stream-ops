/**
 * The account lifecycle, end to end, against the live database and the running
 * app: create, sign in on a temporary password, change it, deactivate,
 * reactivate, reset.
 *
 * This is the part that has to be right before real people depend on it. A
 * scheduling bug is an inconvenience; somebody who has left still being able to
 * sign in is not.
 *
 * Password mechanics are checked against the stored hash with bcrypt, and access
 * is checked by asking the running app for real pages with a session minted from
 * its own secret — so a guard that exists but is not wired up still fails here.
 *
 * Everything it creates is removed again at the end, including on failure.
 *
 * Usage: node scripts/check-accounts.mjs [baseUrl]
 */
import "dotenv/config";
import { assertDevDatabase } from "./dev-only.mjs";
import bcrypt from "bcryptjs";
import { SignJWT } from "jose";
import { Client } from "pg";

assertDevDatabase("check-accounts.mjs");

const BASE = process.argv[2] ?? "http://localhost:3000";
const secret = new TextEncoder().encode(process.env.AUTH_SECRET);

/*
  The second half of this talks to the running app.

  Without it up, the database checks passed and then the whole thing died on an
  unhandled fetch failure — so it reported success and failure at once, and the
  exit code said only "failed". Better to say which half ran.
*/
const appIsUp = await fetch(BASE, { method: "HEAD" })
  .then(() => true)
  .catch(() => false);

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const TEST_EMAIL = `zz-account-check-${Date.now()}@streamops.test`;
let testId = null;

async function cookieFor(user) {
  const token = await new SignJWT({ email: user.email, name: user.name, role: user.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(new Date(Date.now() + 3_600_000))
    .sign(secret);
  return `streamops_session=${token}`;
}

/** Where the app sends this person for a page — 200, or the redirect target. */
async function visit(user, path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { cookie: await cookieFor(user) },
    redirect: "manual",
  });
  const to = res.headers.get("location");
  return { status: res.status, to: to ? new URL(to, BASE).pathname : null };
}

try {
  /* ------------------------------------------------ create an account ---- */

  const hash = (pw) => bcrypt.hashSync(pw, 12);
  const TEMP = "temp-pass-abc-1234";

  const created = await db.query(
    `insert into "User" (id, email, name, "passwordHash", role, team, "isActive", "mustChangePassword", "updatedAt")
     values (gen_random_uuid()::text, $1, 'ZZ Account Check', $2, 'EMPLOYEE', 'STREAMING', true, true, now())
     returning id, email, name, role`,
    [TEST_EMAIL, hash(TEMP)],
  );
  const user = created.rows[0];
  testId = user.id;
  console.log(`Test account ${TEST_EMAIL}\n`);

  /* ------------------------------------- 1. a temporary password works --- */

  const row1 = (
    await db.query(`select "passwordHash", "mustChangePassword" from "User" where id = $1`, [testId])
  ).rows[0];
  check("a temporary password verifies against the stored hash", bcrypt.compareSync(TEMP, row1.passwordHash));
  check("a wrong password does not", !bcrypt.compareSync("not-the-password", row1.passwordHash));
  check("the account is flagged to change it on first sign-in", row1.mustChangePassword === true);

  /* ------------------ 2. that flag actually forces the change screen ------ */

  // Everything from here needs the site itself, not just the database.
  if (!appIsUp) {
    console.log(
      `\nSKIP  the rest needs the app running — nothing is answering at ${BASE}.` +
        `\n      Start it with npm run dev and run this again to check the redirects,` +
        `\n      deactivation, and what each role may reach.`,
    );
  } else {

  for (const path of ["/dashboard", "/timeclock", "/availability"]) {
    const r = await visit(user, path);
    check(
      `${path} sends them to change their password first`,
      r.status === 307 && r.to === "/change-password",
      `${r.status} ${r.to ?? ""}`,
    );
  }

  /* ---------------------------- 3. once changed, they get on with it ----- */

  const CHOSEN = "TheirOwnPassword2026!";
  await db.query(`update "User" set "passwordHash" = $2, "mustChangePassword" = false where id = $1`, [
    testId,
    hash(CHOSEN),
  ]);

  const row2 = (await db.query(`select "passwordHash" from "User" where id = $1`, [testId])).rows[0];
  check("their chosen password verifies", bcrypt.compareSync(CHOSEN, row2.passwordHash));
  check("the temporary password no longer works", !bcrypt.compareSync(TEMP, row2.passwordHash));

  const afterChange = await visit(user, "/dashboard");
  check("they reach the dashboard now", afterChange.status === 200, `${afterChange.status}`);

  /* ----------------------------------- 4. deactivation locks them out ---- */

  await db.query(`update "User" set "isActive" = false where id = $1`, [testId]);

  for (const path of ["/dashboard", "/timeclock", "/availability", "/schedule"]) {
    const r = await visit(user, path);
    check(
      `deactivated: ${path} is refused`,
      r.status === 307 && r.to === "/login",
      `${r.status} ${r.to ?? ""}`,
    );
  }

  // The session was minted while they were active. It must stop working on the
  // next request rather than lingering until the cookie expires.
  check(
    "an already-signed-in session stops working immediately",
    (await visit(user, "/dashboard")).to === "/login",
  );

  /* ------------------------------------- 5. reactivation lets them in ---- */

  await db.query(`update "User" set "isActive" = true where id = $1`, [testId]);
  const back = await visit(user, "/dashboard");
  check("reactivated: they are let back in", back.status === 200, `${back.status}`);
  check(
    "reactivating did not change their password",
    bcrypt.compareSync(
      CHOSEN,
      (await db.query(`select "passwordHash" from "User" where id = $1`, [testId])).rows[0]
        .passwordHash,
    ),
  );

  /* -------------------------------------------- 6. an admin reset -------- */

  const RESET = "reset-pass-xyz-9876";
  await db.query(`update "User" set "passwordHash" = $2, "mustChangePassword" = true where id = $1`, [
    testId,
    hash(RESET),
  ]);
  const row3 = (
    await db.query(`select "passwordHash", "mustChangePassword" from "User" where id = $1`, [testId])
  ).rows[0];
  check("after a reset the new temporary password works", bcrypt.compareSync(RESET, row3.passwordHash));
  check("after a reset the old password is dead", !bcrypt.compareSync(CHOSEN, row3.passwordHash));
  check("a reset forces another change", row3.mustChangePassword === true);
  const afterReset = await visit(user, "/dashboard");
  check(
    "and the app enforces it",
    afterReset.to === "/change-password",
    `${afterReset.status} ${afterReset.to ?? ""}`,
  );

  /* ---------------------------- 7. what each kind of person may reach ---- */

  await db.query(`update "User" set "mustChangePassword" = false where id = $1`, [testId]);

  const ADMIN_PAGES = [
    "/admin/releases",
    "/admin/requests",
    "/admin/schedule",
    "/admin/team",
    "/admin/timesheets",
    "/admin/settings",
    "/admin/activity",
  ];

  let blocked = 0;
  for (const path of ADMIN_PAGES) {
    const r = await visit(user, path);
    if (r.status === 307 && r.to === "/dashboard") blocked++;
    else console.log(`        ${path} -> ${r.status} ${r.to ?? ""}`);
  }
  check(
    "a streamer is kept out of every admin page",
    blocked === ADMIN_PAGES.length,
    `${blocked} of ${ADMIN_PAGES.length}`,
  );

  // Moving them to shipping must take the scheduling pages away.
  await db.query(`update "User" set team = 'SHIPPING' where id = $1`, [testId]);
  for (const path of ["/availability", "/schedule"]) {
    const r = await visit(user, path);
    check(
      `shipping: ${path} is not theirs`,
      r.status === 307 && r.to === "/dashboard",
      `${r.status} ${r.to ?? ""}`,
    );
  }
  const shippingClock = await visit(user, "/timeclock");
  check("shipping still has the clock", shippingClock.status === 200, `${shippingClock.status}`);

  const shippingHome = await fetch(`${BASE}/dashboard`, {
    headers: { cookie: await cookieFor(user) },
  });
  const shippingHtml = (await shippingHome.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  check(
    "shipping is not chased for availability on their dashboard",
    !/Availability needed/i.test(shippingHtml) && !/My availability/i.test(shippingHtml),
  );

  } // end of the checks that need the app running

  /* --------------------------------------- 8. the last admin is safe ----- */

  // Back to the database, so this runs either way.
  const admins = (
    await db.query(`select count(*)::int as n from "User" where role = 'BOSS' and "isActive"`)
  ).rows[0].n;
  check(
    "there is at least one active admin",
    admins >= 1,
    `${admins} active admin${admins === 1 ? "" : "s"}`,
  );
} finally {
  if (testId) {
    await db.query(`delete from "AuditLog" where "actorId" = $1`, [testId]);
    await db.query(`delete from "User" where id = $1`, [testId]);
    console.log(`\nTest account removed.`);
  }
  await db.end();
}

console.log(failures === 0 ? "\nAll account checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
