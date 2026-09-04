/**
 * Route smoke test.
 *
 * Mints a session cookie with the app's own secret and requests every page as
 * both roles, checking status codes, expected content, and — importantly — that
 * employees are redirected away from admin routes.
 *
 * Usage: node scripts/smoke.mjs [baseUrl]
 */
import "dotenv/config";
import { SignJWT } from "jose";
import { Client } from "pg";

const BASE = process.argv[2] ?? "http://localhost:3000";
const secret = new TextEncoder().encode(process.env.AUTH_SECRET);

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const { rows: users } = await db.query(
  `select id, email, name, role, team, "mustChangePassword" from "User" where "isActive" = true order by role, name`,
);
await db.end();

const boss = users.find((u) => u.role === "BOSS");
// A streamer and somebody on shipping are different users of this app: shipping
// has no schedule and no availability, so testing "an employee" with whichever
// name sorts first would check the wrong routes for half the team.
const employee = users.find((u) => u.role === "EMPLOYEE" && u.team === "STREAMING");
const shipping = users.find((u) => u.role === "EMPLOYEE" && u.team === "SHIPPING");
if (!boss) throw new Error("No admin account. Seed the database first (npm run db:seed).");

// Somebody who has not chosen a password yet is redirected off every page. That
// is correct, but it would make every content check below look like a failure,
// so it is said once here and those checks are skipped rather than failed.
for (const u of [boss, employee, shipping].filter((u) => u && u.mustChangePassword)) {
  console.log(`note  ${u.email} has not set a password yet — their pages redirect to /change-password`);
}

async function cookieFor(user) {
  const token = await new SignJWT({ email: user.email, name: user.name, role: user.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(new Date(Date.now() + 3_600_000))
    .sign(secret);
  return `streamops_session=${token}`;
}

const CHECKS = [
  // Either the to-do list, or the "all clear" panel that replaces it.
  { path: '/dashboard', as: 'boss', expectAny: ['Needs your attention', 'Nothing needs you right now'] },
  { path: '/admin/releases', as: 'boss', expect: ['Releases', 'New release', 'Every release'] },
  { path: '/admin/requests', as: 'boss', expect: ['Requests', 'Out with the team'] },
  { path: '/admin/schedule', as: 'boss', expect: ['Build schedule', 'Seats filled', 'Publish'] },
  { path: '/admin/team', as: 'boss', expect: ['Team'] },
  { path: '/admin/settings', as: 'boss', expect: ['Settings', 'Time zone'] },
  { path: '/admin/timesheets', as: 'boss', expect: ['Timesheets', 'Total hours', 'Change log'] },
  { path: '/admin/activity', as: 'boss', expect: ['Activity log', 'Everything'] },
  { path: '/dashboard', as: 'employee', expect: ['Upcoming shows'] },
  { path: '/availability', as: 'employee', expect: ['My availability'] },
  { path: '/schedule', as: 'employee', expect: ['My schedule'] },
  { path: '/timeclock', as: 'employee', expect: ['Time clock', 'Clock in'] },

  // Shipping has no schedule, so those two pages are not theirs to open.
  { path: '/dashboard', as: 'shipping', expect: ['On the clock'] },
  { path: '/timeclock', as: 'shipping', expect: ['Time clock'] },
  { path: '/availability', as: 'shipping', expectRedirect: '/dashboard' },
  { path: '/schedule', as: 'shipping', expectRedirect: '/dashboard' },
  { path: '/admin/team', as: 'shipping', expectRedirect: '/dashboard' },
  // An employee must never reach an admin route.
  { path: '/admin/releases', as: 'employee', expectRedirect: '/dashboard' },
  { path: '/admin/requests', as: 'employee', expectRedirect: '/dashboard' },
  { path: '/admin/schedule', as: 'employee', expectRedirect: '/dashboard' },
  { path: '/admin/settings', as: 'employee', expectRedirect: '/dashboard' },
  { path: '/admin/team', as: 'employee', expectRedirect: '/dashboard' },
  { path: '/admin/timesheets', as: 'employee', expectRedirect: '/dashboard' },
  { path: '/admin/activity', as: 'employee', expectRedirect: '/dashboard' },
  // Signed out, everything bounces to login.
  // The two exports carry the whole schedule and everybody's hours, so they are
  // checked like any other route rather than trusted because they are an API.
  { path: '/api/timesheets/export?from=2026-09-01&to=2026-09-15', as: 'boss', expectStatus: 200 },
  { path: '/api/timesheets/export?from=2026-09-01&to=2026-09-15', as: 'employee', expectStatus: 403 },
  { path: '/api/timesheets/export?from=2026-09-01&to=2026-09-15', as: 'anon', expectRedirect: '/login' },

  { path: '/dashboard', as: 'anon', expectRedirect: '/login' },
  { path: '/admin/releases', as: 'anon', expectRedirect: '/login' },
  { path: '/admin/schedule', as: 'anon', expectRedirect: '/login' },
  { path: '/availability', as: 'anon', expectRedirect: '/login' },
  { path: '/timeclock', as: 'anon', expectRedirect: '/login' },
];

const cookies = {
  boss: await cookieFor(boss),
  employee: employee ? await cookieFor(employee) : null,
  shipping: shipping ? await cookieFor(shipping) : null,
  anon: null,
};

let failures = 0;

for (const check of CHECKS) {
  const actor =
    check.as === "boss" ? boss : check.as === "employee" ? employee : check.as === "shipping" ? shipping : null;
  if (actor && actor.mustChangePassword && !check.expectRedirect) {
    console.log(`SKIP  ${check.as.padEnd(8)} ${check.path.padEnd(20)} must set a password first`);
    continue;
  }
  if (check.as === 'employee' && !employee) {
    console.log(`SKIP  employee ${check.path.padEnd(20)} nobody is a streamer`);
    continue;
  }
  if (check.as === 'shipping' && !shipping) {
    console.log(`SKIP  shipping ${check.path.padEnd(20)} nobody is on shipping`);
    continue;
  }
  const headers = cookies[check.as] ? { cookie: cookies[check.as] } : {};
  const res = await fetch(`${BASE}${check.path}`, { headers, redirect: "manual" });

  if (check.expectRedirect) {
    const location = res.headers.get("location") ?? "";
    const ok = res.status >= 300 && res.status < 400 && location.includes(check.expectRedirect);
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${check.as.padEnd(8)} ${check.path.padEnd(20)} -> ${res.status} ${location}`,
    );
    if (!ok) failures++;
    continue;
  }

  if (check.expectStatus) {
    const ok = res.status === check.expectStatus;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${check.as.padEnd(8)} ${check.path.split('?')[0].padEnd(20)} -> ${res.status}`);
    if (!ok) failures++;
    continue;
  }

  const body = res.status === 200 ? await res.text() : "";
  const missing = (check.expect ?? []).filter((needle) => !body.includes(needle));
  // expectAny: the page legitimately renders one of several states.
  const anyMissing =
    check.expectAny && !check.expectAny.some((needle) => body.includes(needle))
      ? [`one of: ${check.expectAny.join(" / ")}`]
      : [];
  const notFound = [...missing, ...anyMissing];
  const ok = res.status === 200 && notFound.length === 0;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${check.as.padEnd(8)} ${check.path.padEnd(20)} -> ${res.status}` +
      (notFound.length ? `  missing: ${notFound.join(", ")}` : ""),
  );
  if (!ok) failures++;
}

console.log(failures === 0 ? "\nAll route checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
