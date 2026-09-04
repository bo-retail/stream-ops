# StreamOps

Scheduling and time-keeping for a live-selling watch business running day and
night shows on TikTok Shop and eBay Live.

Two manual processes, replaced:

- **Availability & scheduling** — the boss composes a **release** (which days,
  which shows, what hours, which rules) and sends it out; streamers tap what they
  can work and send it back; the boss generates a schedule from that, looks it
  over, and confirms it. An open seat is published and filled later; the one
  thing the app refuses to publish is somebody booked on two shows at once.
- **Time keeping** — everyone clocks in and out from one button. Streamers are
  measured against their published shift; shipping is paid what the clock says.
  The boss can correct an entry, every correction keeps the old version, and the
  result exports to Excel for the CFO to load into QuickBooks.

---

## How the work is shaped

| | |
|---|---|
| Shows | Up to 4 a day — TikTok Day, TikTok Night, eBay Day, eBay Night — chosen per release |
| Hours | Whatever the release says; nights may cross midnight |
| People per show | **2**, fully interchangeable |
| Release | Any dates the boss picks — a week, ten days, a fortnight |
| Pay period | Half a month — 1st–15th, 16th–end. Deliberately independent of releases |
| Time zone | **America/New_York** |

The two people on a show split it between camera and computer and swap halfway.
The app does not record who did which job, because it is not a property of the
schedule: a show needs two names against it, and is not ready until it has both.

Everyone is exactly one of **streamer**, **shipping** or **admin** — one choice,
not a role and a team that could contradict each other.

### Releases

A release is one request for availability: the dates it covers, the shows the
boss put on them, and the rules chosen for it. Nothing is inherited from a
settings page, because this business has no default fortnight — one week is four
shows a day and the next is two.

`DRAFT` (being built, nobody sees it) → `OPEN` (out with the team) → `CLOSED`
(no more answers). The schedule built from it publishes separately.

A show belongs to exactly one release: one platform and slot on one date, full
stop. Two overlapping releases cannot both claim it, and the composer says which
release already has it rather than failing on a constraint.

### Who the generator picks, in order

1. **Fill as many seats as possible** — but never with somebody who did not
   offer that show. An unfillable seat is left empty and flagged in red.
2. **Priority people first** — *if this release switched that on*. The boss
   names them when he builds it, not once in a settings page.
3. **Whoever has used the least of their own availability** — *if this release
   switched that on*. The work is split in proportion to what each person
   offered, so a full-timer carries more without a part-timer ending on nothing.
4. **Fewest shows so far, then name** — even spread, stable across rebuilds.

Rules 2 and 3 are switches, set per release. Rules 1 and 4 are not: one is the
whole point, and the other is what is left when the switches are off.

Generating writes nothing. The whole proposal is shown first — every placement,
the per-person load, and each seat it could not fill — and confirming re-checks
every name against the schedule as it stands at that moment, dropping anything
that has gone stale rather than writing over it.

### What counts as paid time

Shipping is paid exactly what they clocked. For a streamer with a **published**
shift:

| | |
|---|---|
| Clocked in early | shift start counts |
| Clocked in late | clock-in counts |
| Clocked out early | clock-out counts |
| Clocked out late | shift end counts |

Only a published period clamps: a draft can still be rearranged, so measuring
somebody against one would dock them for hours nobody told them to work.

---

## Stack

- **Next.js 15** (App Router, React 19, TypeScript) — server components, server actions
- **PostgreSQL** via **Prisma 7** with the `pg` driver adapter
- **Tailwind CSS v4**
- **Auth** — hand-rolled sessions: bcrypt password hashing, HS256 JWT in an
  httpOnly cookie (`jose`), role checks re-read from the database on every request
- **exceljs** for spreadsheet exports
- **Vitest** for the domain test suite

---

## Local development

```bash
npm install
```

Start a local Postgres (bundled with Prisma, no Docker needed):

```bash
npx prisma dev --name streamops
```

Copy `.env.example` to `.env` and fill it in — including a fresh `AUTH_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Apply the schema and load demo data:

```bash
npm run db:deploy
npm run db:seed
```

Run it:

```bash
npm run dev
```

Sign in as the boss with `SEED_BOSS_EMAIL` / `SEED_BOSS_PASSWORD`. Seeded demo
streamers all use `ChangeMe123!`.

> The bundled `prisma dev` server serves one physical database for every database
> name, so it cannot provide the separate shadow database `prisma migrate dev`
> needs. Author migrations with `prisma migrate diff` (see below) and apply them
> with `npm run db:deploy`. Against a real Postgres, such as Neon, the normal
> `prisma migrate dev` workflow works.

### Creating a new migration

```bash
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script --output prisma/migrations/<timestamp>_<name>/migration.sql
npm run db:deploy
```

`db:deploy` runs `prisma migrate deploy` with the advisory lock disabled and
against the **direct** (non-pooled) endpoint, because Neon's pooler cannot hold
the session-level lock migrations use. It is deliberately **not** part of
`npm run build` — a flaky lock timeout should not fail a deploy.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm test` | Domain test suite (169 tests) |
| `npm run typecheck` | TypeScript, no emit |
| `npm run db:deploy` | Apply pending migrations |
| `npm run db:seed` | Settings, boss account, demo data (`--no-demo` for settings + boss only) |
| `node scripts/smoke.mjs` | Requests every route as a boss, a streamer, somebody on shipping and a stranger; checks status, content and access control |
| `node scripts/check-accounts.mjs` | The whole account lifecycle against the running app: temporary password, forced change, deactivation locking a live session out, reactivation, reset, and who may reach what |
| `node scripts/check-schedule.mjs` | Live data: nobody double-booked, no published period largely unstaffed, night shows crossing midnight |
| `node scripts/check-constraints.mjs` | Proves the *database* refuses the impossible — a third person on a show, one person in both seats, two shows in one slot. All rolled back |
| `node scripts/check-hours.mjs` | Every early/late clocking combination against live data, plus shipping and the published-only rule. All rolled back |
| `node scripts/check-autofill.mjs` | That each release's own rules — priority, proportional, cap — came out as intended |
| `node scripts/check-availability.mjs` | That a draft stays invisible to the scheduler and a sent-in period is locked, read from the rendered pages as the people themselves |
| `node scripts/check-employee-view.mjs` | That an employee sees their own shows and nobody else's |
| `node scripts/readiness.mjs` | "Are we ready to go live?" — demo accounts, demo passwords, demo work on the rota, and the environment |
| `node scripts/backup-all.mjs` | Dumps every table to a timestamped JSON file |

`scripts/` also holds small local-dev helpers: `rebuild-local-db.mjs`,
`row-counts.mjs`, `inspect-db.mjs`, `test-excel.mjs`. None are used at runtime.

> Backup dumps contain every user's password hash. They are gitignored — keep it
> that way.

---

## Deploying to Vercel + Neon

You need a [Neon](https://neon.tech) account and a [Vercel](https://vercel.com)
account — both have free tiers.

**1. Create the database.** In Neon, create a project. Copy two connection strings:

- the **pooled** one (host contains `-pooler`) → `DATABASE_URL`
- the **direct** one → `SHADOW_DATABASE_URL`

**2. Push the code to a Git repo.**

```bash
git push -u origin main
```

**3. Import the repo in Vercel.** Set the **root directory** to `stream-ops` if
the repo contains the whole workspace. Add these environment variables:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon pooled connection string |
| `SHADOW_DATABASE_URL` | Neon direct connection string |
| `AUTH_SECRET` | A fresh 48-byte random string — **not** the local one |
| `SEED_BOSS_EMAIL` | The real boss email |
| `SEED_BOSS_PASSWORD` | A strong password, changed after first sign-in |

**4. Apply the schema to Neon** (once, from your machine):

```bash
npm run db:deploy
npm run db:seed -- --no-demo
```

`--no-demo` creates only the settings row and the boss account — no demo
streamers in production.

**5. Deploy**, sign in as the boss, then add the real team under **Team**. Each
person gets a one-time temporary password to change on first sign-in.

---

## How the pieces fit

```
src/lib/domain/    Pure functions — no database, no framework. All business rules
                   live here and are covered by the test suite.
  dates.ts         Business dates as YYYY-MM-DD strings; DST-correct instants
  periods.ts       Semi-monthly PAY period boundaries — payroll only, not releases
  intervals.ts     Half-open [start, end) overlap — a handover is not a clash
  assign.ts        Who is eligible for a seat, and the order candidates rank in
  schedule.ts      Publish validation: errors that block, warnings that do not
  hours.ts         The paid-hours rule — clock times clamped to a shift

src/lib/server/    Database access. Thin — it loads rows and hands them to domain.
  releases.ts      Releases: the unit the whole app turns on
src/lib/auth/      Password hashing, session cookies, role guards
src/app/           Pages and server actions
```

Pages: `/dashboard`, `/schedule`, `/availability`, `/timeclock` for everyone;
`/admin/releases` (build and send), `/admin/requests` (what is out and what came
back), `/admin/schedule`, `/admin/team`, `/admin/timesheets`, `/admin/settings`,
`/admin/activity` for the boss.

### Things that were deliberate

- **Dates are strings, not `Date` objects.** A `Date` carries an instant, and
  used to mean "Tuesday" it eventually shifts a whole week by a day. Real
  instants are computed only for overlap checks and paid duration, always through
  the configured time zone, so DST is handled correctly.
- **Intervals are half-open.** A show ending at 19:00 and one starting at 19:00
  do not clash — that is a handover, and treating it as a double-booking would
  make the night shift unstaffable.
- **The database enforces what must never happen.** Two people per show, one
  person per seat, one person never in both seats, one open time entry per
  person, clock-out after clock-in — all constraints and unique indexes, not
  app-level checks. `check-constraints.mjs` proves it by trying each one.
- **Tapping is not answering.** Availability saves as it is tapped, so a closed
  tab costs nothing, but it stays a private draft until the person sends the
  period in — the generator, the validator and the boss's picker all read the
  same filtered list, so a half-finished answer can never reach a schedule.
  Sending it in locks it; only the boss can hand it back.
- **Generating is not saving.** A schedule is proposed, reviewed and confirmed.
  Confirming re-validates against the current state and reports what it dropped.
- **No standing defaults.** Show hours, the show list and the scheduling rules
  live on each release. A default that is wrong most weeks is worse than none,
  and a standing rule keeps applying long after the reason for it has gone.
- **Releases and pay periods are independent.** A release is any dates; payroll
  is always 1st–15th and 16th–end. Tying them would force one to distort the
  other.
- **Only a published schedule affects pay.** Drafts move; pay should not.
- **One rule blocks publishing, not two.** An empty seat is a real state of the
  world — the boss publishes what they have, talks to people, and fills it. What
  cannot be published is one person on two shows at once, which is not something
  a conversation resolves.
- **Nothing is quietly overwritten.** Publishing writes a numbered immutable
  snapshot, every time entry keeps its full revision chain, and every change
  anywhere writes an audit row — all of it readable under **Activity**.
