# Getting StreamOps running — start here

Written for someone who has never run a web app before. Follow it in order.

The database lives in the cloud (Neon), so there is nothing to start for it. You
only start **one** thing: the website. It runs from a terminal window and keeps
running until you close it.

---

## PART 1 — Start the website

1. Open the **Start menu**, type `powershell`, press Enter.
2. Copy this line, paste it in, press Enter:

```bash
cd "C:\Users\samue\Downloads\STREAM\stream-ops"; npm.cmd run dev
```

3. Wait until you see `✓ Ready`. Leave this window open — closing it stops the
   site.

> If you see a red error about *"running scripts is disabled"*, you typed `npm`
> instead of `npm.cmd`. The `.cmd` matters on this machine.

---

## PART 2 — Sign in

1. Open your browser and go to **http://localhost:3000**
2. Sign in as the boss:

   - **Email:** `boss@streamops.local`
   - **Password:** `ChangeMe123!`

The first sign-in takes 15–20 seconds. That is the page compiling and the cloud
database waking up. It is quick after that.

To see what an employee sees, sign out and use any of these — all with the
password `ChangeMe123!`:

| Name | Email |
| --- | --- |
| Maya Alvarez | `maya@streamops.local` |
| Devon Clarke | `devon@streamops.local` |
| Priya Raman | `priya@streamops.local` |
| Jonah Weiss | `jonah@streamops.local` |
| Tasha Boyd | `tasha@streamops.local` |
| Luis Moreno | `luis@streamops.local` |
| Erin Kowalski | `erin@streamops.local` |
| Sam Okafor | `sam@streamops.local` |

---

## PART 3 — How the app works

**There are four possible shows on any day:**

| | Day show | Night show |
| --- | --- | --- |
| **TikTok** | ✓ | ✓ |
| **eBay** | ✓ | ✓ |

**You decide which of them actually run, and at what hours, every time.** Nothing
is assumed. A week can be all four every day, or nights only, or nothing at the
weekend — you tick what you want.

**Every show is run by two people.** They split the show between camera and
computer and swap halfway — on a six-hour show that is three hours each. The app
does not track who is doing which job, because the two are interchangeable: a
show just needs two names against it, and it is not ready until it has both.

### Releases — the thing everything hangs off

A **release** is one request for availability. It is the days it covers, the
shows you put on those days, the hours they run, and the rules that apply to it.

**Any dates you like** — a week, ten days, a fortnight. You are not tied to the
calendar.

**Payroll is separate and stays on the 1st–15th / 16th–end split.** A release can
sit inside one of those, span both, or cover three days. The two are deliberately
not tied together, so neither has to distort the other.

There are no standing defaults anywhere. In this business one week is four shows
a day and the next is two, and a default that is wrong most weeks is worse than
no default at all.

### Who is who

Everyone on the Team page is **one** of three things, chosen from a single
*Position* box:

| Position | What it means |
| --- | --- |
| **Streamer** | Sends availability, gets scheduled onto shows |
| **Shipping** | Never scheduled, never asked for availability — clocks in and out freely |
| **Admin** | Runs the whole app |

Nobody is both. A streamer moved to shipping drops out of the scheduler
immediately; if they were already on upcoming shows the app says so rather than
quietly emptying those seats.

### What the boss does

1. **Releases → Start a release.** Pick the dates and give it a name if you like.
2. **Tick the shows.** A grid of your dates against the four possible shows. Quick
   fills for the common shapes — all four every day, weekdays only, nights only —
   then untick the exceptions. Set the day and night hours. **Save the shows.**
3. **Choose the rules for this one** (see Part 5). **Save the rules.**
4. **Send to the team.** Only now does anybody see it. Nothing before this point
   is visible to anyone but you.
5. **Requests** shows you who has answered and who you are waiting on.
6. **Build schedule → Generate schedule.** It works out who goes where and shows
   you the whole thing first. **Nothing is saved until you press Confirm.**
7. **Publish.** The team can only see a schedule once it is published — and pay is
   only measured against a published schedule.

### What an employee does

1. **My availability.** Tap the shows they can work across the release,
   then press **Send in**. That is the whole answer — there is no job to choose,
   since the pair swap halfway.
2. **My schedule.** Once you publish, their shows appear here with who they are
   working with.

### Tapping is a draft. Sending it in is the answer.

Taps save as they go, so somebody can start on the bus and finish at home
without losing anything. But **you do not see it, and the generator does not use
it, until they press Send in.** A half-tapped list is worse than no list,
because it looks like an answer.

**Sending it in locks it.** They cannot change it afterwards — the schedule gets
built on it, so it has to hold still. When somebody genuinely needs to change
theirs, you hand it back: **Requests**, then **Hand back** next to their name.
Their taps are kept, so they are correcting an answer rather than starting from
a blank fortnight.

The **Requests** tab is also where you see **who you are waiting on**: everyone
is listed as Sent in or Waiting, waiting first.

---

## PART 4 — Editing the schedule

Everything on the **Build schedule** page is editable, before or after
publishing. To change *which shows exist*, go back to the release itself —
though once a schedule is published the grid there locks, and you cancel a show
from Build schedule instead, which tells the people on it.

**On any single show** (the small buttons on each card):

| Button | What it does |
| --- | --- |
| 🕐 clock | Change that one show's hours |
| 🚫 ban | Cancel the show |
| ↺ undo | Put a cancelled show back on |
| ✕ | Take a person off, to swap in someone else |

**Cancelling a show** greys it out, stops it needing anybody, and frees both
people for other shows that night. It keeps the two people on it, so putting it
back on restores them.

**On the whole release** (the panel on the right):

- **Generate schedule** — works out who goes where and shows you the result:
  every name against every show, how many shows each person picks up, and any
  seat it could not fill. Nothing is written. Press **Confirm** to save it, or
  **Discard** to throw it away. Generating again is free, as often as you like.
- **Copy last release** — the same people on the same weekday shows as the
  previous release. Matched on weekday, since releases can be any length.
- **Clear everyone** — empties every seat, keeps the shows.
- **Show hours** — change *every* day show or *every* night show at once, across
  this release.

Between generating and confirming, the schedule can move — you might place
somebody by hand in another tab. Confirm checks every name again before it
writes, and drops anything that no longer fits rather than writing over it. It
tells you how many it dropped.

**Download Excel** gives you the whole release as a spreadsheet: a wall-chart
grid, a row per show, and a per-person summary.

**Deleting a release** takes its shows, the schedule on them and everybody's
answers with it. The button asks first and tells you the exact counts. One thing
it will not do: delete a release once somebody has clocked time against its
shows, because that would change what they were already paid.

---

## PART 5 — What the app checks for you

**Red — one thing, and only one, stops you publishing:**

- Someone on two shows at the same time.

That is not something you can sort out later by talking to people — one person
cannot be in two places, and publishing it would tell two shows they have
somebody they do not have.

(Putting the same person on both seats of one show is not even possible — the
database refuses it.)

**Amber — worth a look, but you can publish anyway:**

- **A show with an empty seat.** You publish what you have, then fill the gap
  once you have spoken to people. Publishing again saves a new version, so
  filling it later is normal, not a fix-up.
- Someone on a show they did not offer.
- Someone working a day they booked off.
- Someone over the show limit you set on the release (if you set one).
- People who have not sent their availability in.

The amber ones never block you. You may know something the app does not.

### Who the generator picks, in order

**You choose two of these four rules every time you build a release.** Nothing
carries over from the last one — there is no settings page holding a standing
rule that quietly keeps applying after the reason for it has gone.

1. **Fill as many seats as it can** — but never with somebody who did not offer
   that show. A seat with no willing candidate is left empty and shown in red.
   A name nobody agreed to is worse than a gap. **Always on.**
2. **Give some people priority.** *A switch.* Turn it on and tick the
   people who should get a seat before anybody else, for this release only.
3. **More availability, more work.** *A switch.* On, the work is handed out in
   proportion to what each person offered — offer thirty shows and you get
   roughly three times somebody who offered ten, without the part-timer ending
   on nothing. Off, it is an even spread regardless of who offered what.
4. **Fewest shows so far, then name** — so the work spreads evenly and a rebuild
   gives the same answer twice. **Always on**, and it is what decides things
   when both switches are off.

You can also cap how many shows one person may get from a release. Going over it
is a warning, not a block.

**Priority cannot conjure availability.** Somebody you tick who only
offered six shows gets six — the app will never put anyone on a show they did
not offer. It gets them a bigger share of *their own* availability, not somebody
else's.

It never moves anyone already placed, and it never puts one person in both seats
of the same show.

---

## PART 6 — Clocking in and out

The **Clock** page is one big button. Press it to start, press it to stop. It
shows the time running while you are on.

It only ever shows the **period you are in now** — there is nothing to browse
and nothing to pick. Clocking in always happens at the current moment, so a page
offering other periods would suggest you could clock into one. Earlier periods
are on **Admin → Timesheets**, which is where a correction has to be made
anyway.

**Shipping** is paid exactly what the clock says, start to stop. There is no
schedule to compare against.

**Streamers** are paid against their **published** shift:

| What happens | What counts |
| --- | --- |
| Clock in **early** | The shift start time |
| Clock in **late** | Your clock-in time |
| Clock out **early** | Your clock-out time |
| Clock out **late** | The shift end time |

In short: turning up early or staying late is not paid, and being late or
leaving early is. A shift only counts once the period is **published** — a draft
can still be rearranged, so it is never used to dock anybody.

**Admin → Timesheets** shows both numbers side by side — what was clocked and
what is paid — with lateness and early finishes called out, and any entry the
boss corrected marked as such. Every correction keeps the old version.

**Download Excel** from there gives the CFO three sheets, each carrying a
**Position** column that reads *Streaming* or *Shipping*:

- **Summary** — employee, position, shifts, hours (decimal), not-clocked-out
  count, and a total row.
- **Entries** — every shift, for checking a figure back to its source.
- **Import** — the flat sheet QuickBooks maps from: employee, position, date,
  hours.

Position is on all three because the two are paid on different rules — shipping
on the raw clock, streaming clamped to the published shift — so whoever loads it
into QuickBooks can tell them apart without a second file.

---

## PART 7 — The activity log

**Admin → Activity** is a record of every change anybody has made, anywhere in
the app — schedules, timesheets, people, settings. Newest first, filterable, and
nothing on it can be edited or deleted.

---

## PART 8 — Stopping and starting

**To stop the site:** click the PowerShell window and press **Ctrl + C**.

Do not close the window with the X while it is running, and never force-kill it
from Task Manager.

**To start it again:** repeat Part 1.

**If a page shows an error after you have changed something:** stop the site with
Ctrl + C and start it again. That fixes almost everything.

---

## Before you go live with the real team

1. **Change the boss password.** Everyone currently shares `ChangeMe123!`.
2. **Rotate the database password** in the Neon console — the current one has
   been pasted into a chat window.
3. **Delete the eight demo employees** from the Team page and add your real
   people.
4. **Check Settings** — the show hours and time zone are right for you.
