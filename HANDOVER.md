# StreamOps — handover

Everything a developer needs to take this from these files to a working, live
page. Written to be followed top to bottom.

The database is **empty of demo data**. There are no seeded employees, no sample
shows, no placeholder rows anywhere. Real data is entered through the app.

---

## 1. What it does, and who uses it

A live-selling watch business streams shows on TikTok Shop and eBay Live, day
and night. Two people run each show together. This app replaces two things that
were being done by hand: working out who is on which show, and keeping track of
the hours everyone worked so they can be paid.

There are three kinds of user.

**The admin (the boss).** Builds a *release* — a request for availability
covering whatever dates he chooses, listing exactly which shows run on which
days and at what hours, plus the rules to use when the schedule is generated.
He sends it to the team, watches the answers come in, presses one button to
generate a schedule, reviews it, confirms it, and publishes it. He also manages
accounts, corrects timesheets, and downloads an Excel file of hours for the CFO
to load into QuickBooks.

**Streamers.** Open *My availability*, tap the shows they can work, and press
*Send in*. Once the schedule is published they see their own shows and who they
are paired with. They clock in and out from a single button.

**Shipping staff.** Never scheduled and never asked for availability. They see a
dashboard and a clock, and nothing else.

### The rules the app enforces

Two things it will never do, whatever the settings say:

- Put somebody on a show they did not offer to work.
- Put one person on two shows that overlap.

Two things the admin switches on or off **per release**, chosen fresh each time
rather than stored as a standing default:

- **Priority** — the named people get a seat before anybody else.
- **More availability, more work** — the work is split in proportion to how much
  each person offered. Off means an even spread regardless.

An open seat does **not** block publishing. The admin publishes what he has and
fills the gap after talking to people.

### How hours are counted

Shipping is paid exactly what the clock says. A streamer is measured against
their **published** shift:

| What happened | What counts |
|---|---|
| Clocked in early | the shift start time |
| Clocked in late | their clock-in time |
| Clocked out early | their clock-out time |
| Clocked out late | the shift end time |

Only a published schedule clamps. A draft can still be rearranged, so measuring
somebody against one would dock them for hours nobody told them to work.

---

## 2. Tech stack

| | |
|---|---|
| Framework | Next.js 15.5.23, App Router, React 19.1.0, TypeScript 5 |
| Rendering | Server Components and Server Actions. No client-side data fetching layer, no REST/GraphQL API for the UI |
| Database | PostgreSQL 15+ |
| ORM | Prisma 7.9.1 with the `@prisma/adapter-pg` driver adapter over `pg` |
| Styling | Tailwind CSS v4 |
| Auth | Written in-house. bcrypt password hashing, HS256 JWT in an httpOnly cookie |
| Spreadsheets | exceljs |
| Tests | Vitest |
| Hosting | Vercel (the app) + Neon (the database). Any Node host and any Postgres will do |

There is no third-party auth provider, no email service, no queue, no cache, no
object storage, and no analytics. The app talks to one Postgres database and
nothing else.

---

## 3. Where the code is

This repository **is** the deliverable, complete and final. 196 tracked files,
about 14,800 lines of source. Nothing is stubbed and nothing is omitted.

```
stream-ops/
├── prisma/
│   ├── schema.prisma          the data model
│   ├── schema.sql             complete DDL — every table, index and constraint
│   ├── seed.ts                creates settings + the first admin (see §7)
│   └── migrations/            ordered migration history
├── public/                    static assets
├── scripts/                   operational and verification scripts (§9)
├── src/
│   ├── app/
│   │   ├── (app)/             every signed-in page
│   │   │   ├── admin/         releases, requests, schedule, team,
│   │   │   │                  timesheets, settings, activity
│   │   │   ├── availability/  streamer: tap shows, send in
│   │   │   ├── dashboard/     three variants: admin, streamer, shipping
│   │   │   ├── schedule/      streamer: my shows
│   │   │   └── timeclock/     everyone: clock in and out
│   │   ├── api/
│   │   │   ├── schedule/export/    schedule as .xlsx
│   │   │   └── timesheets/export/  hours as .xlsx, for QuickBooks
│   │   ├── change-password/
│   │   ├── login/
│   │   └── layout.tsx, globals.css, page.tsx
│   ├── components/            shared UI primitives
│   ├── lib/
│   │   ├── auth/              password hashing, sessions, route guards
│   │   ├── domain/            pure business rules + their tests
│   │   └── server/            database reads
│   └── middleware.ts          first gate on every request
├── package.json
├── next.config.ts
├── prisma.config.ts
└── .env.example
```

**Where the business rules live.** `src/lib/domain/` is pure functions — no
database, no framework, no I/O. Everything the app claims to enforce is decided
there and covered by 169 unit tests:

| File | What it decides |
|---|---|
| `assign.ts` | who is eligible for a seat, and the order candidates rank in |
| `schedule.ts` | what blocks publishing and what only warns |
| `hours.ts` | the paid-hours rule — clock times clamped to a shift |
| `intervals.ts` | half-open overlap, so a handover is not a clash |
| `dates.ts` | business dates as strings; DST-correct instants |
| `periods.ts` | semi-monthly **pay** period boundaries |

A file-by-file manifest is in **`MANIFEST.md`**.

---

## 4. Database

### Creating it

Two supported routes. Both give an identical database.

**Recommended — Prisma migrations.** Preserves history and lets future schema
changes apply cleanly:

```bash
npm run db:deploy
```

**Or — one SQL script**, if you would rather not use Prisma Migrate. Run
`prisma/schema.sql` against an empty database. It is 380 lines and creates 8
enums, 13 tables, 42 indexes and every constraint:

```bash
psql "$DATABASE_URL" -f prisma/schema.sql
```

> Note: `prisma/schema.sql` was generated from the schema and then extended by
> hand with three guarantees Prisma's schema language cannot express — the
> two-seats-per-show CHECK, the clock-out-after-clock-in CHECK, and the partial
> unique index allowing only one open time entry per person. If you regenerate
> that file, re-append them; without them the database will store nonsense.

### The tables

| Table | What it holds |
|---|---|
| `User` | everybody who can sign in: name, email, bcrypt hash, role, team, active flag |
| `Settings` | one row. The business time zone, and nothing else |
| `Release` | one request for availability: dates, status, the rules chosen for it |
| `ReleasePriority` | who gets first refusal on one release |
| `Show` | one show: date, platform, slot, start and end instants |
| `Assignment` | one person in one seat of one show |
| `Availability` | one "I can work this show" |
| `AvailabilitySubmission` | "I have finished answering this release" — the lock |
| `TimeOff` | whole days somebody cannot work |
| `TimeEntry` | one clock-in/clock-out pair |
| `TimeEntryRevision` | every version an entry has held |
| `ScheduleSnapshot` | an immutable copy of each published schedule |
| `AuditLog` | every change anyone made, anywhere |

### Guarantees enforced by the database, not by app code

| Guarantee | How |
|---|---|
| One show per platform and slot on a date | `UNIQUE (date, platform, slot)` on `Show` |
| One person per seat | `UNIQUE (showId, seat)` on `Assignment` |
| Never the same person twice on one show | `UNIQUE (showId, userId)` on `Assignment` |
| Only seats 1 and 2 exist | `CHECK (seat IN (1,2))` |
| A shift cannot end before it starts | `CHECK (clockOutAt IS NULL OR clockOutAt > clockInAt)` |
| Only one open time entry per person | partial unique index `WHERE clockOutAt IS NULL` |
| One answer per person per release | `UNIQUE (userId, releaseId)` |

`node scripts/check-constraints.mjs` proves each of these by trying to violate
it, and rolls everything back.

### Connecting

The app reads `DATABASE_URL` and connects with `pg` through Prisma's driver
adapter. On Neon, use the **pooled** endpoint (the host containing `-pooler`).
Migrations need the **direct** endpoint — `prisma.config.ts` derives it by
stripping `-pooler`, so you do not have to configure it twice.

### Starting data

The database starts **empty** except for:

- one `Settings` row (the time zone), and
- one admin account, created by you in §7.

No demo users, no sample releases, no fake shows. Everything else is entered
through the app by real people.

---

## 5. Dependencies

Runtime:

| Package | Version | Why |
|---|---|---|
| `next` | 15.5.23 | framework |
| `react` / `react-dom` | 19.1.0 | UI |
| `@prisma/client` | ^7.9.1 | database client |
| `@prisma/adapter-pg` | ^7.9.1 | driver adapter |
| `pg` | ^8.23.0 | Postgres driver |
| `bcryptjs` | ^3.0.3 | password hashing |
| `jose` | ^6.2.9 | signs and verifies the session JWT |
| `zod` | ^4.4.3 | validates every server action input |
| `exceljs` | ^4.4.0 | the two .xlsx exports |
| `@date-fns/tz` | ^1.5.0 | DST-correct instants |
| `lucide-react` | ^1.31.0 | icons |
| `clsx` + `tailwind-merge` | ^2.1.1 / ^3.6.0 | class names |
| `server-only` | ^0.0.1 | keeps server modules off the client |

Build and test only: `typescript`, `tailwindcss` v4, `@tailwindcss/postcss`,
`eslint` + `eslint-config-next`, `prisma`, `tsx`, `vitest`, `dotenv`, and the
`@types/*` packages.

**No external APIs or services.** Nothing is called over the network at runtime
except your own database.

`npm audit` reports 9 advisories, all in transitive build-time dependencies
(`postcss` under `next`, `mysql2` and `deepmerge-ts` under Prisma's config
loader, `uuid` under `exceljs`). None are reachable from request handling.
Clearing them needs major-version bumps of `next` and `prisma`, which is a
deliberate upgrade rather than part of this handover.

---

## 6. Running it

### Local

```bash
npm install
cp .env.example .env      # then fill it in — see below
npm run db:deploy         # create the tables
npm run db:seed -- --no-demo   # settings + the first admin, nothing else
npm run dev               # http://localhost:3000
```

> On Windows PowerShell, use `npm.cmd` and `npx.cmd`.

### Production

`npm run build` then `npm start`, or let Vercel do both. The build runs
`prisma generate` first. `18` routes, all server-rendered on demand except the
landing page.

Migrations are deliberately **not** part of the build — a flaky advisory-lock
timeout should never fail a deploy. Run `npm run db:deploy` yourself after
deploying a schema change.

### Environment variables

| Variable | Required | What it is |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string. On Neon, the **pooled** one |
| `AUTH_SECRET` | yes | signs session cookies. 48 random bytes, unique per environment |
| `SHADOW_DATABASE_URL` | migrations only | the **direct**, non-pooled endpoint |
| `SEED_BOSS_EMAIL` | first run only | email for the first admin |
| `SEED_BOSS_PASSWORD` | first run only | its temporary password |

Generate a secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Delete `SEED_BOSS_PASSWORD` once the first admin has signed in and set their own
password. `scripts/readiness.mjs` warns while it is still there.

---

## 7. Login and accounts

Written in-house — there is no Auth0, Clerk, or NextAuth. Accounts live in the
`User` table in your own database and nowhere else.

**How a session works.** Sign-in verifies the password with bcrypt (12 rounds)
and sets an httpOnly, SameSite=Lax, Secure cookie holding an HS256 JWT signed
with `AUTH_SECRET`, valid for 7 days.

**The token is not trusted for authorisation.** Every request re-reads the user
from the database, so deactivating somebody stops their existing session on
their very next request rather than when the cookie expires. Sign-in is rate
limited to 10 attempts per 15 minutes per email.

**Three layers**, in order: `middleware.ts` redirects anyone without a cookie;
`requireUser` / `requireBoss` / `requireStreamer` re-read the user and redirect;
every server action checks again for itself, because an action is a public HTTP
endpoint whichever page it was rendered on.

### Creating the first admin

There is no public sign-up — by design. The first account is made from the
command line:

```bash
SEED_BOSS_EMAIL="you@yourcompany.com" \
SEED_BOSS_PASSWORD="a-long-temporary-password" \
npm run db:seed -- --no-demo
```

That creates the `Settings` row and one `BOSS` account, and nothing else. The
account is flagged to change its password, so the first sign-in goes straight to
*Set your password* — the value you put in that env var gets you in once and is
then replaced by one only you know.

### Everyone after that

The admin adds people on **Team**. Each gets a one-time temporary password shown
once on screen, which they must change on first sign-in. The admin can reset
anybody's password (producing a new temporary one) and deactivate anybody.
Deactivated accounts keep their history but cannot sign in or be scheduled.

Everyone is exactly one of **Streamer**, **Shipping** or **Admin** — one choice,
not a role and a team that can contradict each other.

---

## 8. Hosting it under an existing domain

Be aware of what this is: a **full Next.js application with its own database and
its own login**, not a page you can paste into another site. It cannot be
dropped in as a component. It runs as its own deployment. Two ways to put it
under a domain you already own:

**A — Subdomain (recommended).** Deploy this repo as its own Vercel project and
point `schedule.yourdomain.com` at it. Completely independent: its own build,
its own env vars, its own database. Nothing about the existing site changes, and
neither app can break the other.

**B — Path on the existing domain**, e.g. `yourdomain.com/schedule`. Still a
separate Vercel project; the existing site forwards that path to it. In the
**existing** site's `next.config.ts`:

```ts
async rewrites() {
  return [
    { source: "/schedule",           destination: "https://your-streamops-deployment.vercel.app/schedule" },
    { source: "/schedule/:path*",    destination: "https://your-streamops-deployment.vercel.app/schedule/:path*" },
  ];
}
```

and in **this** app's `next.config.ts` add `basePath: "/schedule"` so its own
links and assets resolve under that path.

Option B shares a cookie domain with the parent site — the session cookie is
named `streamops_session`, so it will not collide, but the two sites are no
longer fully isolated. **Option A is the one that matches "zero ties to the
site's other features."**

Either way there is no shared code, no shared database and no shared auth with
the existing site.

---

## 9. Go-live checklist

1. **Create the database.** A Neon project (or any Postgres). Copy both
   connection strings — pooled and direct.
2. **Push this repo** to Git.
3. **Create the Vercel project**, root directory `stream-ops`. Set
   `DATABASE_URL` (pooled), `SHADOW_DATABASE_URL` (direct) and a fresh
   `AUTH_SECRET`. Never reuse a secret from another environment.
4. **Create the tables**, from your machine, pointed at the production database:
   ```bash
   npm run db:deploy
   ```
5. **Create the first admin** — §7. Use a real email and a long temporary
   password.
6. **Deploy.**
7. **Sign in** as that admin. You are sent straight to *Set your password*.
   Choose a real one.
8. **Remove `SEED_BOSS_PASSWORD`** from the Vercel environment variables.
9. **Add the real team** on the Team page — Streamer, Shipping or Admin for
   each. Hand out the one-time passwords. Nobody can sign in until you do this;
   there is no public sign-up.
10. **Check the time zone** on Settings. It drives every show time, clock-in and
    report. Default `America/New_York`.
11. **Run the readiness report** and clear anything it flags:
    ```bash
    node scripts/readiness.mjs
    ```
    It fails on demo accounts, demo passwords, demo work on the rota, a missing
    or short `AUTH_SECRET`, and a non-pooled `DATABASE_URL`.
12. **Verify against the live deployment:**
    ```bash
    node scripts/smoke.mjs https://your-url
    node scripts/check-accounts.mjs https://your-url
    ```
13. **Build the first release** — Releases → pick dates → tick the shows → set
    the hours and rules → Send to the team.

### Verification scripts

All of these read the real database and the running app. They skip with a reason
rather than failing when there is nothing yet to check.

| Command | Proves |
|---|---|
| `npm test` | 169 unit tests over the business rules |
| `npm run typecheck` | TypeScript, no emit |
| `node scripts/readiness.mjs` | are we ready to go live |
| `node scripts/smoke.mjs [url]` | every route as admin, streamer, shipping and a stranger |
| `node scripts/check-accounts.mjs [url]` | the whole account lifecycle, on a throwaway account |
| `node scripts/check-constraints.mjs` | the database refuses the impossible |
| `node scripts/check-schedule.mjs` | nobody double-booked, no stray shows |
| `node scripts/check-hours.mjs` | every early/late clocking combination |
| `node scripts/check-autofill.mjs` | each release's own rules came out as intended |
| `node scripts/check-availability.mjs [url]` | a draft stays private; a sent-in answer locks |
| `node scripts/check-employee-view.mjs [url]` | an employee sees their shows and nobody else's |
| `node scripts/test-excel.mjs [url]` | the schedule export is a real, correct workbook |
| `node scripts/backup-all.mjs` | dumps every table to timestamped JSON |

> Backups contain every user's password hash. They are gitignored — keep it that
> way.

### Operational note

`scripts/wipe-demo-data.mjs --yes` empties everything except one admin. It has
already been run against this database. Keep it for rebuilding a staging
environment; do not run it against production once real data exists.
