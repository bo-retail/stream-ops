# Launching onto the live database

This is an **upgrade of a database that already holds real data**, not a fresh
install. Nothing here deletes anything. Every migration being applied is
additive: new tables, new columns, two new enum values. No column is dropped,
renamed or re-typed, and no existing row is rewritten.

Read §0 and §1 before running anything.

---

## 0. What is being added

| | |
|---|---|
| **Sales report entry** | the morning's TikTok and eBay exports, uploaded by the shipping director |
| **Packing** | scan a label, scan each watch in, close the box |
| **Shipping log** | who packed what, every scan, kept forever |
| **Sales insights** | revenue, best sellers, day against night, marketplace splits |
| **Payroll** | hours at a rate, plus commission on the shows a streamer was on |
| **Scheduled hours** | streamers no longer clock for shows; hours print from the published schedule |

Three migrations, all additive:

- `20260909120000_shipping_boxes_and_imports` — six tables, one new role (`MANAGER`)
- `20260909180000_scheduled_hours` — one enum value, one partial unique index
- `20260909210000_pay_rates` — three columns on `Settings`, two on `User`

---

## 1. Two things to know before you start

**Migrations are run from your machine, not by the deploy.** `npm run build` does
not touch the database on purpose — a build that talks to Postgres fails when the
network hiccups, and a failed deploy over a blip is worse than remembering one
command.

**The enum values must be committed before the index that uses one.**
`20260909180000_scheduled_hours` adds `TimeEntrySource.SCHEDULE` and then creates
an index with `WHERE "source" = 'SCHEDULE'`. PostgreSQL refuses to *use* a new
enum value in the same transaction that added it. It works here only because
Prisma does not wrap a migration file in a transaction — which is true today and
is not a promise. §4 removes the dependency entirely by committing both values
first, after which those two statements are no-ops.

---

## 2. Back up. Twice.

**A Neon branch** is the real safety net — a full point-in-time copy you can
restore or read from:

> Neon console → your project → **Branches** → **New branch** → name it
> `before-shipping-launch`, from **This moment**.

**And a file**, so it does not depend on Neon:

```powershell
$env:DATABASE_URL = "<your Neon POOLED connection string>"
node scripts/backup-all.mjs
```

It reads the table list out of the database rather than a hard-coded one, so it
cannot silently skip a table. Check the row counts it prints look like your
business. **The file contains every password hash — it is gitignored, keep it
that way.**

---

## 3. Point this shell at production

Set them in the shell, not in `.env`. `dotenv` does not override variables that
are already set, so these win for this window only — and closing the terminal
puts everything back. Nothing can be left pointing at production by accident.

```powershell
$env:DATABASE_URL = "<Neon POOLED url — the host containing -pooler>"
$env:DIRECT_URL   = "<Neon DIRECT url — the same host without -pooler>"
```

Confirm you are where you think you are:

```powershell
node -e "console.log(new URL(process.env.DATABASE_URL).hostname)"
```

Then see what is pending. **Read this list before continuing** — it should name
exactly the three migrations in §0. If it names anything else, stop and ask.

```powershell
npx prisma migrate status
```

---

## 4. Commit the two enum values

Run these in the **Neon SQL editor**, one at a time. Both are guarded with
`IF NOT EXISTS`, so running them twice is harmless, and each commits on its own.

```sql
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'MANAGER' BEFORE 'BOSS';
```

```sql
ALTER TYPE "TimeEntrySource" ADD VALUE IF NOT EXISTS 'SCHEDULE';
```

---

## 5. Apply the migrations

```powershell
npm run db:deploy
```

Expect `The following migration(s) have been applied` naming the three from §0.

If it fails partway: nothing is lost. Each migration is recorded only when it
finishes, so re-running continues from where it stopped. If it fails repeatedly,
the branch from §2 is untouched.

---

## 6. Check the database before sending anyone to it

```powershell
node scripts/readiness.mjs
```

It reports accounts, pay rates, schedule integrity, shipping data and migration
state. Two blockers are expected at this point and are cleared in §8:

- *streamers have no hourly rate* — set in §8
- *shipping has no hourly rate* — set in §8

Anything else is real. In particular it must say:

```
ok  the shipping director role exists
ok  hours can be printed from the schedule
ok  every migration applied cleanly
```

---

## 7. Deploy the code

Push, and let Vercel build. No environment variables need to change — the new
features add no secrets.

```powershell
git push
```

---

## 8. Set it up, in this order

1. **Pay rates** — Payroll tab → *What people are paid*. Set the streamer and
   shipping hourly rates. Commission starts at **1%**, paid to **each** person on
   a show, so a show pays out 2% of its sales in total. Until the hourly rates
   are set, everyone's pay exports as `$0.00`, which reads like a real answer —
   the page says so in red until you fix it.

2. **The shipping director** — Team → set that person's position to *Shipping
   director*. Until somebody has it, only you can upload the morning's reports.

3. **The packers** — Team → *Shipping & packer*. They get the packing screen and
   the clock, and nothing else.

4. **Check the current pay period** — Payroll → Sep 1–15. Streamers' hours are
   now printed from the published schedule, and the catch-up reaches back 90
   days. It will never print over a show somebody already clocked, but it *will*
   fill in a published show nobody clocked. Look down the list before you pay
   it. Anything wrong, correct it on the timesheet with a reason; the correction
   stands and is logged.

---

## 9. Prove it works, live

```powershell
node scripts/smoke.mjs https://your-url
node scripts/check-accounts.mjs https://your-url
```

Then by hand, signed in as yourself:

- **Sales report entry** — upload yesterday's three exports. It reads the day out
  of the orders and refuses if that disagrees with the day you picked.
- **Packing** — scan a label from that day. The box opens with what belongs in it.
- **Sales insights** — the day appears, and the figures match the workbook.
- **Payroll** — commission on a show is 1% of what Sales insights says that show
  made. If those two disagree, stop and tell me.

---

## 10. If something is wrong

**The code** — Vercel → Deployments → the previous one → *Promote to Production*.
Instant, and it does not touch the database. The new tables sit unused; the old
code does not know they exist.

**The database** — you should not need to. The migrations only add. If you do:
Neon → Branches → `before-shipping-launch` → restore. Anything entered after the
branch point is lost, so take a fresh backup first.

**Never run** `scripts/wipe-demo-data.mjs` against production. It refuses on its
own if there is real shipping data, but do not test that.

---

## Afterwards

Run this once against production, a week in:

```powershell
node scripts/readiness.mjs
node scripts/check-schedule.mjs
```

`check-schedule` reports a published rota that is mostly unstaffed. It fails on
the two-account development database, which is a quirk of that database and not
of your schedule. Against the real one it should pass — and if it does not, a
published show really is short of a person.
