# StreamOps — Shipping & Packing specification

**Feature 1 of the expansion.** Adds file ingestion, a packing screen for shippers, and a
permanent shipping log for a new Shipping Director position.

Version 0.1 — 2026-09-09. Written from decisions confirmed by Daniel over questions 1–4.
Every ingestion rule references the *BO Retail Sales Report Master Specification v1.1*
(rules R1–R15, steps F1–F10). Where this document and that one disagree, that one wins.

---

## 1. What this is

Every morning the team prints USPS labels for the previous day's orders and hands them
out in stacks. A packer takes the top label, packs that box, closes it, moves on.

**The system assigns nothing.** No claiming, no per-person queues, no distribution.
Handing out paper already divided the work. The system's only job is: given a scanned
label, say what belongs in that box, confirm each item goes in, and record that it
shipped and who shipped it.

### The one principle

> **What is physically in the box is the truth.** Marketplace data says what *should* be
> there; the packer's scan establishes what *is*. When they disagree the scan wins and
> the data gets corrected — never the other way around.

Every rule below is downstream of that sentence.

---

## 2. Positions and access

One new `Role` value, `MANAGER`. Positions become:

| Position | role / team | Sees |
|---|---|---|
| Admin | `BOSS` / `STREAMING` | Everything |
| Shipping Director | `MANAGER` / `SHIPPING` | Sales Report Entry · Shipping log · scan page · time clock |
| Packer | `EMPLOYEE` / `SHIPPING` | Scan page · time clock |
| Streamer | `EMPLOYEE` / `STREAMING` | Unchanged — none of this |

`requireBoss` tests for `BOSS` exactly, so the new role is kept out of the admin pages
with no change to it. A new `requireShipping` guard admits `BOSS`, `MANAGER`, and
`EMPLOYEE`/`SHIPPING`; a new `requireShippingDirector` admits `BOSS` and `MANAGER`.

The Director can pack but normally won't — the scan page sits below the log on her nav.
The boss's sidebar stays flat.

---

## 3. Ingestion

**This section is the crucial one.** It is the same parse that will later feed sales and
commission, so it is built once, correctly, and never duplicated.

### 3.1 Where files enter

Sales Report Entry lists show days drawn from **published** releases, newest first. Each
day has a drop zone for that morning's three files. Only the Director and the boss can
upload. This is the only door data enters the system through.

### 3.2 Recognising the files (F1)

Recognise by **content**, not filename.

| Platform | Definitive test |
|---|---|
| TikTok | Line 1 is the header, first cell `Order ID`, 63 columns |
| eBay | Line 1 is all commas; line 2 is the header, first cell `Sales Record Number`, 82 columns |

Both are UTF-8 **with BOM** — decode BOM-aware or the first header carries an invisible
prefix. Both may contain quoted cells with embedded newlines (TikTok `Shipping
Information`), so use a real CSV parser, never line splitting.

**Structural validation runs before anything else.** Compare the header list, in order,
against the expected list. A missing, renamed or reordered header **stops the upload** —
no boxes, no numbers, and a message naming the header that changed. Columns appended at
the end are tolerated with a warning. This check protects every rule that follows.

If fewer or more than two TikTok files arrive, process what is there and warn. Never
merge two TikTok files into one show.

### 3.3 TikTok (F2)

1. Load every column **as text**. Never let the reader infer types — IDs lose precision
   and `1,022.25` fails.
2. **Trim every cell.** This removes the trailing tab characters on `Order ID`, `SKU ID`,
   `Product ID`, every `* Time` column, `Zipcode` and `Package ID`, and the leading space
   in the header ` Virtual Bundle Seller SKU`.
3. Parse numbers by removing `$` and `,`; blank → 0.
4. Parse datetimes as `MM/DD/YYYY h:mm:ss AM/PM`. **All are Pacific (R2).** Eastern is
   Pacific + 3h. Parse with a fixed `America/Los_Angeles` zone — *not* `Settings.timezone`,
   which is the business zone and a different thing entirely.
5. **Determine the show for the whole file (R1):** take the earliest `Created Time`. Hour
   before 16:00 PT → AM show, otherwise PM. Show date is the Pacific calendar date of that
   earliest order. Every row in the file inherits it, including PM orders whose Eastern
   time has crossed midnight.
   *(16:00 PT is 19:00 ET — the same Day/Night boundary StreamOps already uses.)*
6. **Classify (R3, R5, R6):** `Order Status = Canceled` → **dropped**. Blank `Paid Time`
   → dropped. Otherwise a paid sale. Never decide this from `RTS Time`, `Tracking ID`,
   `Package ID` or `Shipped Time` (R10).
7. **Shift tag (R1, R13):** `Seller SKU`. Validate, default to the file's show if
   malformed, keep the original, raise a flag.
8. One TikTok row = one order = one watch (R3).

> **Correction to the master spec's column table.** Its A3 listing has columns 10 and 11
> the wrong way round. The real exports for 08/30, 09/08 and 09/09 all read
> `9 Product Name`, `10 Variation`, `11  Virtual Bundle Seller SKU`, `12 Quantity` — the
> spec has `Virtual Bundle` at 10 and `Variation` at 11. Neither column is used for
> anything, so no figure was ever affected, but a parser built positionally from the spec
> refuses the file. The header contract in the code follows the files, not the spec.

> **Known tag drift.** The 09/07 and 09/08 files tag rows `09.08.26 AM`. The 08/30 file
> tags them `08.29.26 TT AM` — with `TT` inserted. The master spec's R13 pattern
> `MM.DD.YY AM|PM` rejects the second form, which would flag every row on such a file.
> The validator must accept an optional platform token between the date and the AM/PM.
> This does not affect shipping; it will matter for commission.

### 3.4 eBay (F3)

1. Skip line 1. Line 2 is the header. Drop all-empty rows (line 3 always is). Stop at the
   first blank line; what follows is footer (`N,record(s) downloaded,` and `Seller ID : …`).
2. Footer `N` must equal the count of distinct `Sales Record Number`s. Warn if not.
3. Currency is text with `$`; dates are `Mon-DD-YY` with **no time component**.
4. Show date is `Sale Date`. **On eBay the tag decides the show, not the file (R15)** —
   the file cannot, since one file holds every eBay show of the day and carries no time.
5. **Group by `Sales Record Number` (R7).** Within a group:
   - **Summary row** — `Item Number` blank. Carries order totals, buyer and ship-to.
     Exists only when a multi-item order was paid.
   - **Item row** — `Item Number` present. Carries `Item Title`, `Custom Label`,
     `Tracking Number`, `Transaction ID`.
6. **Paid test (R6, R7):** the group is paid if **any** row in it has a non-blank
   `Paid On Date`. Otherwise every row in the group is dropped.
7. **Watches come from item rows only (R8).** The summary row's money is the sum of its
   children and must never be counted. It is kept only to confirm payment and to supply
   the buyer and ship-to fields, which are **blank on item rows**.

### 3.5 The columns that matter, and the ones that look like they do

| Concept | TikTok | eBay |
|---|---|---|
| **Tracking (the box key)** | `Tracking ID` | `Tracking Number` |
| **Stock number (the item)** | `Product Name` | `Item Title` |
| Buyer | `Buyer Username` | `Buyer Username` |
| Ship-to | `Recipient` *(masked)*, `State` | `Ship To Name`, `Ship To State` *(from summary on multi-item)* |

**Do not use** — these carry names that sound right and are not:

| Looks like the item | Actually is |
|---|---|
| TikTok `Seller SKU` | the show tag, `09.07.26 AM` |
| TikTok `SKU ID` | a 19-digit internal listing id |
| eBay `Item Number` | eBay's 12-digit listing id |
| eBay `Custom Label` | the show tag again |

TikTok masks recipient, city and street (`M****** H****`); eBay does not. The packing
screen will therefore look inconsistent between platforms. This is the source data, not
a bug.

### 3.6 Integrity checks — every upload, all blocking unless noted

Verified passing on the real 09/08 files (473 watches, 220 boxes):

| # | Check | Real result |
|---|---|---|
| 1 | Every paid row has a tracking number | 0 missing |
| 2 | Every paid row has a stock number | 0 missing |
| 3 | No box spans more than one buyer | 0 |
| 4 | No box spans more than one platform | 0 |
| 5 | No tracking number appears on both platforms | 0 |
| 6 | No tracking number is a suffix of another *(warn, not block)* | 0 |
| 7 | All tracking numbers are 22 digits | all 22 |
| 8 | `Net + Shipping + Tax = Order Total` ±0.01 (F5) | passes |

Check 6 is why suffix matching is safe: two distinct strings of equal length cannot be
suffixes of one another. It exists to catch the day that stops being true.

### 3.7 Re-uploading

A day may be uploaded again — a corrected export, a missing file. Re-upload **replaces
the expected contents of boxes that are still open** and creates any new boxes. It must
never touch a closed box, alter a scan event, or delete a package that has scans against
it. Corrections cannot rewrite history — the same rule StreamOps already applies to
timesheet revisions.

---

## 4. The box

**A box is a tracking number.** One tracking number, one physical box, one buyer.
Several orders can share it — that is a combined shipment and it is still one box.
On TikTok, `Package ID` and `Tracking ID` were exactly 1:1 across 146 boxes, so tracking
is as good as the explicit grouping and is the only thing the packer can scan.

A box's contents are **counts per stock number**, not a checklist:

```
9234690390470910236904   mike.honcho059   M****** H****, Illinois
   49746   0 of 3
   48080   0 of 2
   15261   0 of 1
   …  17 watches across 14 distinct stock numbers
```

Duplicates are normal and common — this is a real box from 09/08. Three separate scans of
an identical barcode must all be accepted and all must count. A tick-list would reject the
second scan and strand the packer holding a watch the system says shouldn't exist.

**Box lookup is global, never scoped to a day.** There is no rollover logic and no
"yesterday's leftovers" queue: a label from any past stack scans and opens normally. The
day decides only which boxes an upload creates and what the log defaults to showing.

---

## 5. The scan flow

### 5.1 Label scan

The scanner returns the USPS IMpb string, not the bare tracking number:

```
420 13057 9200190390470919012873
 │    │    └── the tracking number, 22 digits — what the file holds
 │    └── destination ZIP5
 └── USPS routing prefix
```

Matching: strip non-digits, then find the tracking number the scan **ends with**. This
sidesteps every prefix variant (`420`+ZIP5 = 30 digits, `420`+ZIP+4 = 34, bare = 22) with
no format guessing. Exactly one match opens the box; more than one is impossible per
check 6 and is refused with a flag if it ever occurs.

| Outcome | Behaviour |
|---|---|
| Known, open | Box opens with its contents |
| Known, already closed | **"Already packed"** — three words, not an error. Duplicate labels are normal: reprints, leftovers on the bench |
| Not in the system | Box opens **empty** and is packable. Recorded as what it actually contained, and listed on the Director's reconcile queue |

### 5.2 Item scan

Compare case-insensitively against the box's expected stock numbers.

| Outcome | Behaviour |
|---|---|
| Expected, count remaining | Accepted, counter ticks (`49746 — 2 of 3`) |
| Expected, count already full | Refused — "all 3 already scanned" |
| Not expected | **Refused — "Not in this box."** She puts the watch back |

The refusal is the point of the whole screen — it is what catches the wrong item going
into the wrong box. An `Add anyway` override exists for the case where the data is genuinely
wrong; using it marks the box incomplete.

### 5.3 Closing

```
Not started  →  In progress  →  Closed · complete
                             ↘  Closed · incomplete
```

**Close** is disabled until every counter is full. Beneath it, visually subordinate,
**Close incomplete** is always available: it records exactly what went in, stamps the box
`INCOMPLETE` permanently, and surfaces it on the Director's exception queue. No reason is
required — the system already knows precisely what was short — but an optional one-line
note is offered.

Closing marks the box shipped **for everyone**, stamped with who closed it and when.

---

## 6. The log

The evidentiary record. Its purpose, in Daniel's words: *so we can dispute a customer
saying they got the wrong watch.*

**Every scan is its own permanent row** — not a counter that ticks up:

```
09:14:22  María  box 9234690390470910236904  LABEL SCANNED — 17 expected
09:14:51  María  ├─ 49746   accepted   (1 of 3)
09:15:08  María  ├─ 49746   accepted   (2 of 3)
09:15:33  María  ├─ 48080   accepted   (1 of 2)
09:16:01  María  ├─ 51774   REFUSED — not in this box
09:21:40  María  └─ CLOSED · complete
```

- **Refused scans are recorded.** A rejection proves the control worked and the wrong
  watch was caught. Discarding them would delete the best evidence.
- **Every override is logged** — `Add anyway`, `Close incomplete`, any reopen — with who.
- **Append-only, forever.** Rows are never edited or deleted; a correction adds a row.

**What it proves, precisely:** that model `49746` was scanned into that box, three times,
by a named person, at a known moment — and that model `51774` was not. What it cannot do
is distinguish the three physical `49746`s, because the barcode encodes the model, not the
unit (R4). And it records what was *scanned*, the best available proxy for what was sealed
in the box.

**Volume:** ~700 scan events a day at the real rate of 220 boxes and 473 watches — about
250,000 rows a year. Postgres will not notice. "Forever" is literal.

### The Director's views

**The day it opens on is yesterday, not today.** Yesterday's shows are packed this
morning, so the date that matters when the screen is opened is almost always the one
before. A date control moves a day at a time in either direction, and any past date can
be pulled up — the log is permanent, so every day that ever ran is reachable.

The headline, and the reason the screen exists at all:

```
Tuesday 9 September — packing the shows of Monday 8 September

    173 of 220 boxes sent            47 still to go
    ────────────────────────────────────────────────
    María      96 boxes   214 items    07:41 — 11:58
    Ana        61 boxes   139 items    08:03 — 11:57
    Luis       16 boxes    38 items    09:40 — 10:22
```

The total comes from the day's upload: **boxes to send** is how many the sales reports
produced, **boxes sent** is how many have been closed. Both figures are meaningless
without an upload, so a day with no report shows the banner in §6.1 instead of a
counter of zero.

Below the headline:

- Per person: boxes packed, items packed, first scan, last scan
- Incomplete boxes queue
- Unrecognised-label reconcile queue
- Full scan detail for any box

Visible to the Shipping Director and the boss. Packers do not get this screen — they get
their scanner and nothing else.

### 6.1 The missing-report banner

A show ran and nobody uploaded its reports. Nothing downstream can happen — no boxes to
pack, no sales, no commission — and the failure is silent, because an empty screen looks
much like a quiet day.

So: **a day with shows but no report raises a banner** for the Shipping Director and the
boss, on their dashboard and on Sales Report Entry, naming the dates and linking straight
to the upload.

A date qualifies when all of these hold:

- it is **strictly before today** in the business zone — today's shows have not finished,
  and their reports do not exist until tomorrow morning
- it carries at least one **`SCHEDULED`** show in a **published** release — a day whose
  shows were all cancelled needs no report, and a draft was never a commitment
- **no successful import exists** for it
- it falls inside a **14-day** look-back — older than that is history, not a prompt

The banner does not dismiss. It goes away when the report is uploaded, which is the
point. Packers never see it: they cannot act on it.

### 6.2 Downloading the consolidated sales workbook

The boss can download any day's sales as the workbook, in the shape the manual run
produced — the format that was already read and trusted.

Three sheets: `Summary`, `Sales`, `Exceptions`. Arial. Currency as
`$#,##0.00;($#,##0.00);-`. The `Sales` sheet frozen below its header row and filtered.
`BO_Retail_Show_Sales_{YYYY-MM-DD}.xlsx`, named for the show date.

**One day by default; a range on request.** A range produces the same three sheets over
every show day in it, named `BO_Retail_Show_Sales_{start}_to_{end}.xlsx`. The `Summary`
keeps its familiar shape — one row per show, totalled across the range — and gains a
second table beneath it breaking the same figures down by day, because over a fortnight
"which day was that" is the first question anyone asks.

Every figure on `Summary` is a **live formula** over `Sales` — `COUNTIFS` and `SUMIFS`,
never a pasted value (F6) — so correcting a row in the workbook recalculates the totals
rather than leaving them contradicting the rows beneath them.

> **One fix against the earlier run.** Its distinct-buyer count used
> `SUMPRODUCT((show=X)/COUNTIFS(...))`, which accumulates floating-point error and
> renders as `87.000000000000043` buyers. The formula is kept — it is the right shape —
> wrapped in `ROUND(…, 0)`.

Built with `exceljs`, already a dependency, following the two export routes the app
has: `api/schedule/export` and `api/timesheets/export`.

Per-person numbers are **activity, not a timesheet**. First and last scan bracket when
someone was actually packing — more honest than login times, since people stay signed in
for weeks — but it knows nothing about breaks. The time clock remains the payroll record.
The whole tab depends on each person having their own login, and per-person data only
exists from the day per-person logins do.

---

## 7. Data model

Five new tables. Enum `Role` gains `MANAGER`.

| Table | Holds |
|---|---|
| `ImportBatch` | one upload of a day's files — show date, who, when, file names and hashes, row counts, blocking-check results |
| `SalesRecord` | the F4 unified record, one row per paid watch — full money detail, stored now, surfaced when the sales screens are built |
| `Package` | the box — tracking (unique), platform, buyer, ship-to, show date, status, closedBy, closedAt, `isUnrecognised` |
| `PackageItem` | expected contents — package, stock number, expected qty, scanned qty |
| `ScanEvent` | append-only log — package, user, timestamp, kind (`LABEL`, `ITEM_ACCEPTED`, `ITEM_REFUSED`, `ITEM_OVERRIDE`, `CLOSE_COMPLETE`, `CLOSE_INCOMPLETE`, `REOPEN`), stock number, note |

Database-level guarantees, following the existing schema's habit of enforcing what matters
in Postgres rather than app code:

- `UNIQUE (trackingNumber)` on `Package` — one box per tracking, and the thing that makes
  a closed box closed for everyone under concurrent scanning
- `UNIQUE (packageId, stockNumber)` on `PackageItem`
- `CHECK (scannedQty >= 0)` and `CHECK (expectedQty >= 0)`
- `ScanEvent` has no update or delete path in the application at all

**Production has no `_prisma_migrations` table** — the schema was built by pasting SQL into
Neon. The migration ships as reviewed SQL to be run by hand, with the Prisma migration
committed alongside so the repo stays consistent.

---

## 8. Test plan

The ingestion is the part that must be impeccable, because sales and commission will be
built on the same parse.

1. **Unit tests, pure functions, no database** — same pattern as `src/lib/domain`.
   TikTok: BOM, trailing tabs, `1,022.25`, cancelled rows, the 16:00 PT show boundary,
   midnight crossing, tag validation including the `TT` variant. eBay: line-1 skip, empty
   row, three footer lines, summary/child grouping, the any-row paid test.
2. **Golden-file test against the real 09/08 exports.** Must produce exactly: 473 watches,
   220 boxes, 146 TikTok / 74 eBay, 307 / 166 watches, biggest TikTok box 17 watches
   containing `49746 ×3` and `48080 ×2`, 16 boxes spanning both TikTok shows.
3. **The eight integrity checks** as assertions.
4. **Label matching** — the real scan `420130579200190390470919012873` resolves to
   tracking `9200190390470919012873`; the 30- and 34-digit and bare forms all resolve.
5. **Scan flow** — duplicate model counting, over-scan refusal, unexpected-item refusal,
   override paths, close gating, already-packed, unrecognised label.
6. **The existing 169 tests must still pass**, plus `npm run typecheck` and a clean build.

> **Fixtures must not contain customer data.** The eBay export carries unmasked buyer
> names, addresses and phone numbers. Committing the real files as test fixtures would put
> customer PII in a Git repository. Fixtures are generated by an anonymiser that preserves
> structure, quirks, tracking formats and stock numbers while replacing every personal
> field. The real exports stay out of Git.

---

## 9. Out of scope

Named so nobody builds them by accident:

- The sales and commission **screens**. The data is captured from day one and the
  workbook can be downloaded (§6.2); the on-screen reporting comes later.
- Commission itself — the rate, and how it splits between the two people on a show, are
  not yet decided.
- Anything that assigns work to a packer. Paper does that.
- Unit-level watch traceability. The barcode is a model (R4).
- Inventory. Stock numbers identify models, and repeat sales are normal, not oversells.
- Replacing the time clock. The log is activity, not payroll.
