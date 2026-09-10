/**
 * "Are we ready to go live?" — read straight from the database.
 *
 * Reports what is real business data versus leftover demo data, and whether the
 * things that are dangerous to leave at their defaults have actually been
 * changed. Run it against production before sharing the URL with the team.
 *
 *   node scripts/readiness.mjs
 */
import "dotenv/config";
import { Client } from "pg";
import bcrypt from "bcryptjs";

/*
  A connection that survives being dropped.

  This holds one connection open across the whole report, and part of that
  report is a bcrypt comparison per account — seconds of pure CPU with nothing
  said to the database. A managed Postgres that scales to zero will happily hang
  up during that, and the script died on an unhandled ECONNRESET halfway
  through, having printed half an answer.

  So the connection is re-made when it is found to be gone. Every query here is
  a read, so retrying one cannot do anything twice.
*/
const connectionUrl = process.env.DATABASE_URL;
let client = null;

async function connect() {
  const c = new Client({
    connectionString: connectionUrl,
    connectionTimeoutMillis: 30_000,
    keepAlive: true,
  });
  // Without a listener, a dropped connection is an unhandled 'error' event and
  // takes the process down before the retry below ever runs.
  c.on("error", () => {});
  await c.connect();
  return c;
}

const db = {
  async query(...args) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (!client) client = await connect();
        return await client.query(...args);
      } catch (error) {
        const dropped = ["ECONNRESET", "EPIPE", "ETIMEDOUT", "57P01"].includes(
          error.code ?? "",
        );
        if (!dropped || attempt === 3) throw error;
        try {
          await client?.end();
        } catch {
          /* it is already gone */
        }
        client = null;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  },
  async end() {
    try {
      await client?.end();
    } catch {
      /* already closed */
    }
  },
};

let blockers = 0;
let warnings = 0;

const fail = (msg, detail = "") => {
  console.log(`  BLOCKER  ${msg}${detail ? ` — ${detail}` : ""}`);
  blockers++;
};
const warn = (msg, detail = "") => {
  console.log(`  warning  ${msg}${detail ? ` — ${detail}` : ""}`);
  warnings++;
};
const ok = (msg, detail = "") => console.log(`  ok       ${msg}${detail ? ` — ${detail}` : ""}`);

/* ------------------------------------------------------------- accounts */

console.log("\nAccounts");

const { rows: users } = await db.query(
  `select id, email, name, role, team, "isActive", "mustChangePassword", "passwordHash"
   from "User" order by role, name`,
);

const bosses = users.filter((u) => u.role === "BOSS" && u.isActive);
const streamers = users.filter((u) => u.role === "EMPLOYEE" && u.team === "STREAMING" && u.isActive);
const shipping = users.filter((u) => u.role === "EMPLOYEE" && u.team === "SHIPPING" && u.isActive);
const directors = users.filter((u) => u.role === "MANAGER" && u.team === "SHIPPING" && u.isActive);

if (bosses.length === 0) fail("no active admin account");
else {
  ok(
    `${bosses.length} admin, ${streamers.length} streamer(s), ${shipping.length} packer(s), ` +
      `${directors.length} shipping director(s)`,
  );
}

// Without a director, nobody but the admin can upload the morning's reports —
// and without those there is no packing list and no sales.
if (directors.length === 0 && shipping.length > 0) {
  warn(
    "no shipping director",
    "only an admin can upload the day's reports until somebody is given that position",
  );
}

// Demo accounts are recognisable by their address, not by their password.
const demo = users.filter((u) => u.email.endsWith("@streamops.local"));
if (demo.length > 0) {
  fail(
    `${demo.length} demo account(s) still present`,
    demo.map((u) => u.email).join(", "),
  );
}

// The seeded password is public knowledge — anyone who has read the docs has it.
const stillDefault = [];
for (const u of users) {
  if (await bcrypt.compare("ChangeMe123!", u.passwordHash)) stillDefault.push(u.email);
}
if (stillDefault.length > 0) {
  fail(
    `${stillDefault.length} account(s) still using the documented demo password`,
    stillDefault.join(", "),
  );
} else {
  ok("nobody is using the documented demo password");
}

const neverSignedIn = users.filter((u) => u.isActive && u.mustChangePassword);
if (neverSignedIn.length > 0) {
  ok(
    `${neverSignedIn.length} account(s) awaiting first sign-in`,
    "they will be asked to set their own password",
  );
}

/* ------------------------------------------------------------- settings */

console.log("\nSettings");

const { rows: settingsRows } = await db.query(`select * from "Settings" where id = 'singleton'`);
if (settingsRows.length === 0) {
  fail("no settings row");
} else {
  const s = settingsRows[0];
  console.log(`           time zone   ${s.timezone}`);
  ok("settings present");
  console.log("           show hours and scheduling rules are set on each release, not here");

  /* --------------------------------------------------------------- pay */

  console.log("\nPay rates");

  const money = (c) => `$${(c / 100).toFixed(2)}`;
  console.log(`           streamers   ${money(s.streamerHourlyCents)}/hour`);
  console.log(`           shipping    ${money(s.shippingHourlyCents)}/hour`);
  console.log(
    `           commission  ${s.streamerCommissionBps / 100}% of a show's sales, to each person on it`,
  );

  // Hours at nothing an hour come out as a total of nothing, which reads
  // exactly like a real answer on a payroll export.
  if (s.streamerHourlyCents === 0 && streamers.length > 0) {
    fail("streamers have no hourly rate", "their pay will export as $0.00");
  } else if (streamers.length > 0) {
    ok("streamers have an hourly rate");
  }
  if (s.shippingHourlyCents === 0 && shipping.length + directors.length > 0) {
    fail("shipping has no hourly rate", "their pay will export as $0.00");
  } else if (shipping.length + directors.length > 0) {
    ok("shipping has an hourly rate");
  }

  const { rows: own } = await db.query(
    `select name, "hourlyRateCents", "commissionBps" from "User"
     where "isActive" and ("hourlyRateCents" is not null or "commissionBps" is not null)`,
  );
  if (own.length > 0) {
    ok(`${own.length} person(s) on a rate of their own`, own.map((u) => u.name).join(", "));
  }
}

/* ---------------------------------------------------------------- data */

console.log("\nSchedule data");

const { rows: counts } = await db.query(`
  select
    (select count(*)::int from "Release") as weeks,
    (select count(*)::int from "Release" where "scheduleStatus" = 'PUBLISHED') as published,
    (select count(*)::int from "Show") as shows,
    (select count(*)::int from "Assignment") as assignments,
    (select count(*)::int from "Availability") as availability,
    (select count(*)::int from "TimeOff") as time_off,
    (select count(*)::int from "AuditLog") as audit
`);
const c = counts[0];
console.log(
  `           ${c.weeks} release(s), ${c.published} published · ${c.shows} shows · ${c.assignments} assignments`,
);
console.log(`           ${c.availability} availability rows · ${c.time_off} days off · ${c.audit} audit entries`);

// Assignments belonging to demo accounts would put fake names on a real rota.
const { rows: demoWork } = await db.query(`
  select count(*)::int as n from "Assignment" a
  join "User" u on u.id = a."userId"
  where u.email like '%@streamops.local'
`);
if (demoWork[0].n > 0) {
  fail(`${demoWork[0].n} assignment(s) belong to demo accounts`);
} else if (c.assignments > 0) {
  ok("every assignment belongs to a real account");
}

/* ------------------------------------------------------------ integrity */

console.log("\nIntegrity");

const { rows: clashes } = await db.query(`
  select count(*)::int as n
  from "Assignment" a1
  join "Assignment" a2 on a2."userId" = a1."userId" and a2.id > a1.id
  join "Show" s1 on s1.id = a1."showId" and s1.status = 'SCHEDULED'
  join "Show" s2 on s2.id = a2."showId" and s2.status = 'SCHEDULED'
  where s1."startsAt" < s2."endsAt" and s2."startsAt" < s1."endsAt"
`);
if (clashes[0].n > 0) fail(`${clashes[0].n} person(s) double-booked`);
else ok("nobody double-booked");

const { rows: short } = await db.query(`
  select count(*)::int as n from (
    select s.id from "Release" w
    join "Show" s on s."releaseId" = w.id and s.status = 'SCHEDULED'
    left join "Assignment" a on a."showId" = s.id
    where w."scheduleStatus" = 'PUBLISHED'
    group by s.id having count(a.id) < 2
  ) x
`);
if (short[0].n > 0) warn(`${short[0].n} published show(s) short of a person`);
else ok("every published show has both people");

/* ------------------------------------------------------ sales and shipping */

console.log("\nSales and shipping");

const { rows: shipRows } = await db.query(`
  select
    (select count(*)::int from "ImportBatch") as uploads,
    (select count(*)::int from "ImportBatch" where status = 'BLOCKED') as blocked,
    (select count(*)::int from "SalesRecord") as sales,
    (select count(*)::int from "Package") as boxes,
    (select count(*)::int from "Package" where status = 'OPEN') as open_boxes,
    (select count(*)::int from "Package" where status = 'CLOSED_INCOMPLETE') as incomplete,
    (select count(*)::int from "ScanEvent") as scans
`);
const sh = shipRows[0];
console.log(
  `           ${sh.uploads} upload(s), ${sh.blocked} refused · ${sh.sales} sales rows · ${sh.boxes} boxes · ${sh.scans} scans`,
);
if (sh.uploads === 0) {
  console.log("           nothing uploaded yet — that starts on the Sales report entry tab");
} else {
  ok(`${sh.boxes} box(es) on record, ${sh.open_boxes} still open`);
  if (sh.incomplete > 0) {
    warn(`${sh.incomplete} box(es) were closed incomplete`, "each one is a parcel short a watch");
  }
}

// A day uploaded twice is normal — a corrected export. Every figure reads only
// the most recent one, so this is reported rather than flagged.
const { rows: dupes } = await db.query(`
  select to_char("showDate", 'YYYY-MM-DD') as day, count(*)::int as n
  from "ImportBatch" where status = 'OK'
  group by "showDate" having count(*) > 1 order by "showDate"
`);
if (dupes.length > 0) {
  ok(
    `${dupes.length} day(s) uploaded more than once`,
    `only the most recent counts — ${dupes.map((d) => `${d.day} x${d.n}`).join(", ")}`,
  );
}

// A scan without a name is not evidence, and the database refuses to delete an
// account that has made one. This is what would block deactivating somebody.
const { rows: orphan } = await db.query(`
  select count(*)::int as n from "ScanEvent" s
  left join "User" u on u.id = s."userId" where u.id is null
`);
if (orphan[0].n > 0) fail(`${orphan[0].n} scan(s) have no account behind them`);

/* ----------------------------------------------------------- environment */

console.log("\nEnvironment (this machine — check Vercel separately)");

const secret = process.env.AUTH_SECRET ?? "";
if (secret.length < 32) fail("AUTH_SECRET missing or under 32 characters");
else ok(`AUTH_SECRET set (${secret.length} chars)`);

const url = process.env.DATABASE_URL ?? "";
if (!url) fail("DATABASE_URL not set");
else {
  ok(url.includes("-pooler.") ? "DATABASE_URL uses the pooled endpoint" : "DATABASE_URL set");
  if (!url.includes("-pooler.")) {
    warn("DATABASE_URL is not the pooled endpoint", "use the -pooler host for the app");
  }
}

if (process.env.SEED_BOSS_PASSWORD) {
  warn("SEED_BOSS_PASSWORD is still in your .env", "remove it once the real admin exists");
}

/* ------------------------------------------------------------- migrations */

console.log("\nMigrations");

const { rows: applied } = await db.query(`
  select migration_name, finished_at, rolled_back_at
  from _prisma_migrations order by started_at
`);
const unfinished = applied.filter((m) => m.finished_at === null && m.rolled_back_at === null);
const rolledBack = applied.filter((m) => m.rolled_back_at !== null);

console.log(`           ${applied.length} applied`);
if (applied.length > 0) {
  console.log(`           latest: ${applied[applied.length - 1].migration_name}`);
}
if (unfinished.length > 0) {
  fail(
    `${unfinished.length} migration(s) never finished`,
    unfinished.map((m) => m.migration_name).join(", "),
  );
} else if (rolledBack.length > 0) {
  fail(
    `${rolledBack.length} migration(s) rolled back`,
    rolledBack.map((m) => m.migration_name).join(", "),
  );
} else {
  ok("every migration applied cleanly");
}

// The two enum values the newest features depend on. If a migration half-applied
// these would be missing while the tables around them exist, and the failure
// would only show up when somebody was given the position or a show started.
const { rows: enums } = await db.query(`
  select t.typname, e.enumlabel
  from pg_type t join pg_enum e on e.enumtypid = t.oid
  where t.typname in ('Role', 'TimeEntrySource')
`);
const labels = new Set(enums.map((e) => `${e.typname}.${e.enumlabel}`));
if (!labels.has("Role.MANAGER")) fail("the MANAGER role is missing", "no shipping director can exist");
else ok("the shipping director role exists");
if (!labels.has("TimeEntrySource.SCHEDULE")) {
  fail("TimeEntrySource.SCHEDULE is missing", "streamers' hours cannot be printed from the schedule");
} else {
  ok("hours can be printed from the schedule");
}

/* -------------------------------------------------------------- verdict */

console.log(
  blockers === 0
    ? `\nReady to go live.${warnings > 0 ? ` ${warnings} warning(s) worth a look.` : ""}`
    : `\nNOT ready: ${blockers} blocker(s)${warnings > 0 ? `, ${warnings} warning(s)` : ""}.`,
);

await db.end();
process.exit(blockers === 0 ? 0 : 1);
