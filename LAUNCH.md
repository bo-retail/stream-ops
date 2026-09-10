# Launching StreamOps — step by step

This adds shipping, sales, insights and payroll to the StreamOps site your team
already uses. **Your existing data is not touched.** Everything being added is
new tables and new columns — nothing is deleted, renamed or rewritten.

Read this once before starting. Then do it with this open beside you.

**You can stop between any two steps.** Nothing is half-done in a way that
breaks. The one place that matters is called out when you get there.

**Time:** about 45 minutes — roughly 20 for the update itself, and another 25
loading the three days you have already run and shipped.

---

## What you will be using

| | What it is | Where |
|---|---|---|
| **PowerShell** | A window where you type commands. Blue or black background, white text. | Windows key → type `powershell` |
| **Neon** | Where your database lives. | https://console.neon.tech |
| **Vercel** | Where the website lives. | https://vercel.com |
| **GitHub** | Where the code lives. You will not need to open it. | — |

### How to use PowerShell if you never have

- **To open it:** press the **Windows key**, type `powershell`, press **Enter**.
- **To paste a command:** copy it from here, click once inside the PowerShell
  window, then **right-click**. Right-click *is* paste. Then press **Enter**.
- **A command has finished** when you get a new line starting with `PS C:\...>`
  and a blinking cursor. Until then it is still working — wait.
- **Red text is a problem.** Yellow text is usually just a warning and fine.
- **Nothing printed at all** usually means it worked. Many commands only speak up
  when something is wrong.

> If any step gives you red text you were not told to expect, **stop and send me
> the whole thing**. Nothing so far will have broken.

---

## The one rule

**Update the database first. Send the code second.**

Steps 1–7 update the database. Step 8 sends the code. In that order, your live
site keeps working normally the whole way through — the new tables just sit there
unused until the new code arrives.

The other way round, the new code arrives looking for tables that do not exist
yet, and the new pages break until you catch up. So: **do not run step 8 early.**

---

# Step 1 — Open PowerShell in the right folder

Open PowerShell (Windows key → `powershell` → Enter), then paste this and press
Enter:

```powershell
cd "C:\Users\danib\OneDrive\STREAM OPS\stream-ops"
```

**What you should see:** the line at the bottom now starts with
`PS C:\Users\danib\OneDrive\STREAM OPS\stream-ops>`.

Leave this window open. You will use it for most of this. Do not use the window
that is running your development site — open a fresh one.

---

# Step 2 — Get your two database addresses

Your database has **two** addresses. They look almost identical. You need both,
and it matters which is which.

1. Go to **https://console.neon.tech** and sign in.
2. Click your project.
3. Find **Connection Details** (usually on the main page).
4. Copy the connection string. It looks like:

   ```
   postgresql://neondb_owner:AbC123@ep-cool-forest-12345-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require
   ```

That one — **with `-pooler` in it** — is the **POOLED** address.

Now make the second one yourself: take that same text and **delete just the
`-pooler` part**. That gives you the **DIRECT** address:

```
postgresql://neondb_owner:AbC123@ep-cool-forest-12345.us-east-1.aws.neon.tech/neondb?sslmode=require
```

Paste both into Notepad for a moment so you have them side by side. **Do not
send them to me or put them in a document you share** — they are the keys to
your database.

> If Neon shows you a dropdown with **Pooled connection** as a checkbox, you can
> just tick and untick it to get each version rather than editing the text.

---

# Step 3 — Back up. Twice.

Nothing in this launch deletes anything. This is here so that sentence never has
to be tested.

## 3a — A copy of the database at Neon

1. In the Neon console, click **Branches** in the left menu.
2. Click **New branch**.
3. Name it: `before-shipping-launch`
4. Under "Create from", choose **This moment** (or "Current point in time").
5. Click **Create**.

That is a complete copy of your database as it is right now, kept at Neon. If
anything ever went badly wrong, this is what you would restore from.

## 3b — A copy on your own computer

In PowerShell, paste this — **but first replace `PASTE_POOLED_HERE`** with your
POOLED address from step 2. Keep the quote marks.

```powershell
$env:DATABASE_URL = "PASTE_POOLED_HERE"
```

Press Enter. Nothing will print. That is correct.

Now paste this and press Enter:

```powershell
node scripts/backup-all.mjs
```

**What you should see:** a list of table names with numbers beside them, then a
line like `4213 rows across 19 tables saved to backup-all-20260909T181500.json`.

**Check the numbers look like your business** — the right sort of number of
users, shows, and so on. If everything says 0, you are pointed at the wrong
database. Stop and tell me.

> That file contains everyone's scrambled passwords. It stays on your computer
> and is already set to never be uploaded anywhere. Leave it alone.

---

# Step 4 — Tell PowerShell where the database is

Paste this, replacing `PASTE_DIRECT_HERE` with your DIRECT address (the one
**without** `-pooler`). Keep the quote marks.

```powershell
$env:DIRECT_URL = "PASTE_DIRECT_HERE"
```

Press Enter. Nothing prints. Correct.

Now check you are pointed at the right place:

```powershell
node -e "console.log(new URL(process.env.DATABASE_URL).hostname)"
```

**What you should see:** your Neon address, something like
`ep-cool-forest-12345-pooler.us-east-1.aws.neon.tech`.

**If it says `127.0.0.1` or `localhost`**, step 3b did not take. Do it again.

> These settings only exist inside this one PowerShell window. Closing the window
> removes them. Your development setup is not affected at all.

---

# Step 5 — Look at what is about to change — **then stop**

```powershell
npx prisma migrate status
```

This takes about 15 seconds and **changes nothing**. It only looks.

**What you should see:** near the bottom, a list of four things not yet applied:

```
20260909120000_shipping_boxes_and_imports
20260909180000_scheduled_hours
20260909210000_pay_rates
20260910100000_sent_without_scanning
```

## → Stop here and send me what it printed.

Copy the whole output and paste it to me. I will tell you whether it is what we
expect before you run anything that writes. **If it lists anything other than
those three, do not continue.**

---

# Step 6 — Two lines in the Neon website

This is the fiddly bit, and it is the reason step 5 exists. Two small commands
have to be run on their own, before the main update, or the update can fail
halfway on some versions of the database software.

1. In the Neon console, click **SQL Editor** in the left menu.
2. Paste this **on its own** and click **Run**:

   ```sql
   ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'MANAGER' BEFORE 'BOSS';
   ```

3. Clear the box. Paste this **on its own** and click **Run**:

   ```sql
   ALTER TYPE "TimeEntrySource" ADD VALUE IF NOT EXISTS 'SCHEDULE';
   ```

4. Clear the box. Paste this **on its own** and click **Run**:

   ```sql
   ALTER TYPE "PackageStatus" ADD VALUE IF NOT EXISTS 'CLOSED_UNVERIFIED';
   ```

5. Clear the box. Paste this **on its own** and click **Run**:

   ```sql
   ALTER TYPE "ScanKind" ADD VALUE IF NOT EXISTS 'CLOSE_UNVERIFIED';
   ```

**What you should see:** something like `ALTER TYPE` or "Query executed
successfully" each time.

Both are safe to run more than once — if you are unsure whether one worked, just
run it again. It cannot do harm.

---

# Step 7 — Update the database

Back in PowerShell:

```powershell
npm run db:deploy
```

This takes 30–60 seconds.

**What you should see:**

```
The following migration(s) have been applied:
  20260909120000_shipping_boxes_and_imports
  20260909180000_scheduled_hours
  20260909210000_pay_rates
  20260910100000_sent_without_scanning
All migrations have been successfully applied.
```

**If it stops partway with red text:** nothing is lost. Each part is only
recorded once it fully finishes, so running `npm run db:deploy` again picks up
where it stopped. Try once more. If it fails again, stop and send me the red
text.

---

# Step 8 — Check the database is healthy

```powershell
node scripts/readiness.mjs
```

**What you should see:** several sections. Two lines saying **BLOCKER** are
*expected right now* and get fixed in step 10:

```
BLOCKER  streamers have no hourly rate
BLOCKER  shipping has no hourly rate
```

These three lines **must** be there:

```
ok  the shipping director role exists
ok  hours can be printed from the schedule
ok  every migration applied cleanly
```

If those three are there, the database is ready. Any *other* blocker, send it
to me.

---

# Step 9 — Send the code to the website

```powershell
git push
```

This takes about 20 seconds and prints several lines ending in something like
`main -> main`.

Vercel then builds and publishes automatically. Watch it at
**https://vercel.com** → your project → **Deployments**. It takes 2–4 minutes and
finishes with a green **Ready**.

**When it goes green, the new tabs are live.**

---

# Step 10 — Set it up, in this order

Open your live site and sign in as yourself.

## 10a — Set what people are paid

Go to **Payroll** in the left menu (it used to say Timesheets).

Find the box called **What people are paid** and fill in:

- **Streamer, per hour** — e.g. `18.00`
- **Shipping, per hour** — e.g. `16.00`
- **Commission, per show** — already `1`. Leave it unless you want to change it.

Click **Save rates**.

> **Commission is 1% to each person on a show.** Two people on a show means the
> show pays out 2% of its sales in total. That is what you asked for.

Until you do this, everyone's pay shows as **$0.00**, and the page tells you so
in red.

## 10b — Appoint your shipping director

**Team** → find the person → change their position to **Shipping director**.

Until somebody has this, **only you** can upload the morning's report files.

## 10c — Add your packers

**Team** → each packer → position **Shipping & packer**.

They will see only the packing screen and the clock. Nothing else.

---

# Step 11 — Load the days that already shipped

You have been running shows since Monday, and those parcels have already gone
out. Their sales still want loading — that is where the revenue, the insights
and the streamers' commission come from — but nobody is going to scan six
hundred labels that are already in the post.

So load each day, then tell the app they went out.

**Do this for each day — Monday, Tuesday, Wednesday:**

## 11a — Upload the day

**Sales report entry** → pick the day → drop in that day's export files →
**Upload**.

It reads the date out of the files themselves and refuses if that disagrees with
the day you picked, so you cannot put Monday's orders on Tuesday by accident.

## 11b — Tell it those parcels have gone

**Shipping log** → use **← Previous day** until the title says that day.

You will see a yellow box: *"These parcels already went out"*, saying how many
are still open.

1. Click **Mark this day as sent**
2. Type the reason: `shipped before we started using StreamOps`
3. Click **Yes — mark N sent**

**What this does:** closes every open box for that day at once, and records each
one as **sent, but never scanned here** — *not* as checked. Nobody verified
them, and the record says so honestly. The daily counter goes to
`220 of 220 sent` and stops nagging.

**What you still get:** if a customer complains about a Monday parcel, you can
open the Shipping log for Monday, find that tracking number, and see what the
report said was in it. What you do not get is proof of what was physically put
in, because nobody scanned it. That is the truth, and the app says so rather
than pretending otherwise.

> **This button is not just for launch.** Any day the scanner dies, the wifi
> drops, or the team forgets to use the app — the parcels still go out, and this
> is how you tell the system so. It is behind a confirmation and needs a reason
> typed in every time, on purpose.

**From tonight's shows onward, pack normally.** Upload in the morning, scan the
labels, close the boxes. You should never need this button again unless
something breaks.

---

# Step 12 — Check the pay period before you pay anybody

Go to **Payroll** and look at **1–15 Sep**.

Streamers' hours now appear automatically from the published schedule — they no
longer clock in for shows. Anything anybody already clocked is left exactly as it
was. But a published show that nobody clocked will now be filled in.

**Read down the list before you pay it.** If a show shows hours for somebody who
was not there, click to correct it on the timesheet and type a reason. The
correction sticks and is recorded.

---

# Step 13 — Try the new things

Still signed in as yourself:

1. **Sales report entry** → pick yesterday → drop in yesterday's three export
   files → **Upload**. It reads the date out of the files themselves and refuses
   if that disagrees with the day you picked.
2. **Packing** → scan a shipping label from that day. The box should open showing
   exactly what belongs in it.
3. **Sales insights** → yesterday should now be there with revenue and watches.
4. **Payroll** → click a commission figure. The shows behind it appear.

**The one thing to check carefully:** a show's commission must be exactly 1% of
what **Sales insights** says that show made. If those two numbers disagree, stop
and tell me.

---

# Step 14 — Close the PowerShell window

Just close it. That is what removes your production database address from your
computer's memory. Nothing else to do.

---

# If something goes wrong

## The website is broken

1. **https://vercel.com** → your project → **Deployments**
2. Find the deployment from **before today**
3. Click the **⋯** menu → **Promote to Production**

This is instant and **does not touch your database**. The new tables simply sit
unused, exactly as they did before step 9.

## Something is wrong with the data

You should not need this — nothing in the launch deletes anything. But if you do:

**Neon** → **Branches** → `before-shipping-launch` → **Restore**.

Anything entered after you made that branch would be lost, so take a fresh backup
first and talk to me before doing it.

## Never run this

```
scripts/wipe-demo-data.mjs
```

It empties the database. It now refuses to run when there is real shipping data
in there — but do not go looking for the edge of that.

---

# A week later

Run these two against production once, to confirm everything settled:

```powershell
node scripts/readiness.mjs
```

```powershell
node scripts/check-schedule.mjs
```

`check-schedule` says a published schedule is understaffed. On the development
computer it always says that, because there are only two test accounts on it. On
your real schedule it should pass — and if it does not, a published show really
is short of a person, and that is worth knowing.
