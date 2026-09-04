# StreamOps cheat sheet

## Start the website

```bash
cd "C:\Users\samue\Downloads\STREAM\stream-ops"; npm.cmd run dev
```

Then open **http://localhost:3000**. Stop it with **Ctrl + C** in that window.

Always `npm.cmd`, never plain `npm`, on this machine.

## Logins

Boss: `boss@streamops.local` · Everyone: `ChangeMe123!`

Employees: `maya@` `devon@` `priya@` `jonah@` `tasha@` `luis@` `erin@` `sam@`
— all `…@streamops.local`.

## The shape of a day

- Up to 4 shows a day: TikTok Day, TikTok Night, eBay Day, eBay Night
- **You pick which run and at what hours, on every release** — no defaults
- 2 people per show — they split it and swap halfway (3 and 3 on a 6-hour show)
- A **release** is any dates you like; **payroll** stays 1st–15th and 16th–end

## The order things happen

1. Boss: **Releases → Start a release** → tick the shows → set the rules → **Send to the team**
2. Team: **My availability** → tap the shows they can work, then **Send in**
   (taps are a private draft until they do; sending it in locks it)
3. Boss: **Requests** to see who is in · **Build schedule → Generate schedule**,
   look it over, **Confirm**, fix the rest, **Publish**
4. Team: **My schedule** → their shows and who they are with

## Positions

One box on the Team page, three answers — nobody is more than one:

| | |
| --- | --- |
| **Streamer** | scheduled onto shows, sends availability |
| **Shipping** | never scheduled, clocks in and out freely |
| **Admin** | runs the app |

## Availability

Taps are a private draft — you do not see them and the generator ignores them
until the person presses **Send in**. Sending it in **locks** it.

To let somebody change a sent-in answer: **Requests** → **Hand back** next to
their name. That tab lists everyone as Sent in or Waiting, waiting first.

## Clocking in and out

Shipping: paid exactly what the clock says.

Streamers, against their **published** shift:

| | |
| --- | --- |
| in early | shift start counts |
| in late | clock-in counts |
| out early | clock-out counts |
| out late | shift end counts |

A draft schedule never counts.

The employee clock page shows the current period only — no browsing, nothing to
pick. Past periods live on **Admin → Timesheets**.

## Who the generator picks

Set per release, every time. Nothing carries over.

1. Fill the most seats — never with somebody who did not offer the show *(always on)*
2. **Priority** *(switch)* — tick who, on the release itself. Capped by
   their own availability, never someone else's
3. **More availability, more work** *(switch)* — offer 3x as much, get ~3x the
   work. Off = even spread regardless
4. Fewest shows so far, then name *(always on; decides it when both switches are off)*

Optional cap per release on how many shows one person may get.

## Deleting a release

On the release page: **Delete release** → it tells you the exact counts → confirm.
Takes the shows, the schedule and everybody's answers with it.

Refused if anybody has clocked time against its shows — that would change pay
already earned.

## Payroll export

**Admin → Timesheets → Download Excel.** Three sheets, each with a **Position**
column (Streaming / Shipping): Summary, Entries, and the flat Import sheet
QuickBooks maps from.

## Show buttons

| | |
| --- | --- |
| 🕐 | change this show's hours |
| 🚫 | cancel this show |
| ↺ | put it back on |
| ✕ | take a person off |

## Checks

**Blocks publishing:** same person on two shows at once. (Same person in both
seats of one show is refused outright by the database.)

**Warns only:** empty seat · not offered · booked that day off · over the period
limit · availability not sent in.

An empty seat does **not** block you — publish it, fill it after you have spoken
to people, publish again.

## Useful commands

```bash
npm.cmd test
```

Runs the 169 rule tests (staffing, clashes, availability, time off, periods,
paid hours).

```bash
npx.cmd tsc --noEmit
```

Checks every file for type errors.

```bash
node scripts/check-schedule.mjs
```

Checks the live data: nobody double-booked, no show short of a
person, night shows crossing midnight properly.

```bash
node scripts/check-constraints.mjs
```

Proves the database itself refuses the impossible: a third person on a show, one
person in both seats, two shows in the same slot. Every attempt is rolled back.

```bash
node scripts/smoke.mjs
```

Loads every page as boss, as employee, and signed out — confirms employees
cannot reach admin pages.

```bash
node scripts/check-hours.mjs
```

Proves the paid-hours rule against the live database: every early/late
combination, shipping paid raw, and drafts never counting. Rolled back after.

```bash
node scripts/check-employee-view.mjs
```

Confirms an employee sees their own shows and nobody else's.

```bash
node scripts/backup-all.mjs
```

Dumps every table to a timestamped JSON file. Run before anything risky.

```bash
npm.cmd run db:deploy
```

Applies any pending database migrations. Deliberately **not** part of the build:
run it yourself after pulling changes that include a new migration. Nothing
happens if there are none.

## If something breaks

**A page errors after a change** — stop with Ctrl + C, start again.

**"running scripts is disabled"** — you used `npm` instead of `npm.cmd`.

**Port 3000 in use** — a copy is already running. Find and stop it:

```bash
Get-NetTCPConnection -LocalPort 3000 -State Listen | Select-Object OwningProcess
```

**Nothing works at all** — the cloud database may be asleep. Load a page and
wait 20 seconds.

## Before going live

- [ ] Change the boss password
- [ ] Rotate the Neon database password
- [ ] Remove the 8 demo employees, add the real team
- [ ] Confirm show hours and time zone in Settings
