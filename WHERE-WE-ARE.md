# Where we are — 28 September 2026

A handover between working sessions. `HANDOVER.md` describes the app itself and
does not change; this file is the state of play and gets rewritten as it moves.

Read `CLAUDE.md` first — it is the standing rule about how work is done here.

---

## The one-paragraph version

StreamOps is live and the floor is using it every day. The launch was 09/18. Since
then the work has been in two streams: **fixing what the floor hits** (report
uploads, packing scans) and **preparing inventory**, which is the next thing to be
built and is currently waiting on answers from the boss. Everything below is the
detail behind those two sentences.

---

## Who is who

| | |
|---|---|
| **Samuel** | Operations, the person in these sessions. Pushes code from GitHub Desktop signed in as the boss. |
| **Daniel** | The boss. Owns GitHub, Vercel and Neon. Builds the schedule, decides the business rules. |
| **Gladys** | Shipping manager. Uploads the daily sales reports, counts shipments in, packs. |
| **Andres** | Rebuilds inventory every morning with an xlookup. That job is what inventory is meant to end. |
| **Claudia, Flora** | Flora holds the expense reporting that the profitability phase will need. |

---

## What went live recently

Newest first. All on `main`, all deployed.

| Commit | What it does |
|---|---|
| `bbee38a` | An eBay report is placed by the seller account named on its last line, and each file in an upload is placed on its own terms. Unblocks a day when both businesses had eBay shows. |
| `e75ec19` | A two-parcel order's labels both open its box. eBay writes both tracking numbers into one cell; 90 of 158 parcels on 09/26 could not be scanned at all. |
| `2bd84e3` | A report is refused only for numbers that decide something — tracking and order references. Rounded Item Number or Transaction ID is a warning, not a refusal. |
| `8d01092` | A report edited for a sample show can be uploaded; one a spreadsheet has wrecked is refused with what went wrong and how to avoid it. |
| `77f3470` | The review rule, written into `CLAUDE.md`. |
| `d4516b8`, `e1ccecd`, `099018b` | Packing scans: none are dropped, the scan after closing a box is the next parcel, and what the review found in both. |
| `55dbee1` | The upload day is typed in rather than chosen from the schedule. |

---

## Open threads, most pressing first

**1. The 09/26 orphaned boxes.** Every parcel that would not scan that day went
through "Pack it anyway", which stored the whole scan as its own unrecognised
box. Those still match first, so there may be up to 90 pairs: an unrecognised box
holding the real scans, and a report box nobody will ever close. No code change
fixes this — it needs a read-only listing script first, then a decision (close the
orphans, or move the scans across). Nobody should be closing boxes by hand until
that list exists.

**2. Inventory — the next build, blocked on nothing but answers.** Daniel answered
two rounds of questions; a third of 33 is with him
(`Inventory - everything still open.docx`, in Samuel's Downloads). The design is
settled enough to start steps 1–3. See the `inventory-phase` memory note for the
full picture; the short version:

- Stock is per model, in five places: sellable, one sample per platform (eBay and
  TikTok), random pulls, damaged.
- "Random pulls" is a state, not an event — a model with a sample and no sellable
  stock. That physical sample ships.
- Gladys's count is the truth, not Invicta's shipping list.
- Stock comes off on **paid** orders. Cost is the shipping-list price, weighted
  average, free freight.
- Build order: count → catalogue and stock → receiving → deduction → movements →
  eBay selection (750 cap) → morning numbers → profitability.

**3. A published diamond release.** Diamond reports import correctly (verified:
29 sales, 23 boxes on 09/26) but commission cannot be attributed without a
published release covering those dates. The diamond release was one of three
Daniel deleted on 09/22.

**4. September's lost data.** On 09/22 Daniel deleted three published releases —
113 shows, 192 placements, **105 paid hour entries** — so September's commission
attributes to nobody. Recovery means a Neon point-in-time branch from just before
09/23 01:15 UTC. Neon's history window may well have passed by now; check before
promising anything. See `release-delete-incident-0922`.

**5. The delete guard.** Nothing stops a release with days already worked and
hours already paid from being deleted; a typed reason is enough. This is what
caused item 4 and it is still possible today.

**6. Neon password.** It was on screen in screenshots during the launch. Reset it
in Neon and update `DATABASE_URL` in Vercel in the same sitting, or the site goes
down between the two.

**7. The floor test of the scan fixes.** Close a box, scan the next label once,
then two watch scans back to back. Never confirmed.

---

## Things learned the hard way

Each of these cost a day or nearly did.

- **Excel destroys reports.** Opening a CSV and saving it rounds anything over 15
  digits: a 22-digit tracking number becomes `9.43461E+21`, and 135 parcels become
  2. It also rewrites dates and the `Custom Label` show tag. The app refuses when
  tracking or the order references are gone, warns when only ignorable columns are.
  The safe way to edit is Google Sheets with "Convert text to numbers" off, or
  Excel's Data → From Text/CSV with every column set to Text. There is a document
  for Gladys: `Instructions for when we run a sample show.docx`.
- **A false refusal is as expensive as a silent error.** A guard that refuses a
  whole day means a day nobody can import, however many times it is downloaded
  again. Measure before refusing — one rule was tested against 2,000 synthetic days
  and refused 23% of untouched ones.
- **eBay's export names its seller** on the last line (`Seller ID : …`), and
  writes both tracking numbers into one cell for a two-parcel order.
- **A sample show sells under one stand-in listing**, so the order carries no model
  number. The packer's scan reads Invicta's barcode, which *is* the model number;
  their own sticker restarts at 1 every show and identifies nothing.
- **The eBay show tag decides which pair is paid.** eBay records no time of day, so
  `09.23.26 PM` in Custom Label is the only thing separating the day show from the
  night one. Random-pull listings are often created without it.
- **Deploys change the server action ids**, so anyone with a page open must refresh
  before their next click. Always say so.

---

## How work is done here

1. Build it, run `npx tsc --noEmit`, `npx next lint --max-warnings=0`,
   `npx vitest run`, plus whichever `scripts/check-*.mts` covers what was touched
   (they need a development database and refuse to run against production).
2. Hand the diff to an independent reviewer subagent. **Every time** — it has
   found a real defect in every change so far, including two that would have
   stopped the floor.
3. Run the what-ifs: the real situations the change will meet, each actually
   run as a test or check-script step, expected against actual, and kept in
   the tests afterwards. See `CLAUDE.md` step 3.
4. Fix what they find, or say why not.
5. Commit on `main` so there is one button for Samuel to press, tell him which
   deployment title to watch for in Vercel, and whether the floor must refresh.

**Never handle passwords or connection strings.** When a script needs production,
give Samuel the commands and let him paste the string into his own PowerShell.
Production scripts are read-only by construction — one `BEGIN TRANSACTION READ
ONLY`, rolled back. `scripts/why-one-upload-day.mjs` and
`scripts/preview-schedule-update.mjs` are the pattern to copy.

---

## Where things live

- **Import rules** — `src/lib/domain/imports/` (`ebay.ts`, `tiktok.ts`, `csv.ts`,
  `boxes.ts`, `tracking.ts`, `placeholders.ts`, `ebay-business.ts`). Pure, tested.
- **The upload itself** — `src/lib/server/imports.ts`.
- **Packing and scanning** — `src/lib/server/packing.ts`,
  `src/app/(app)/shipping/scan-client.tsx`.
- **Schedule, payroll, releases** — `src/lib/server/{schedule,payroll,releases}.ts`.
- **Checks** — `scripts/check-*.mts`. The packing ones are
  `check-packing`, `check-scan-after-close`, `check-two-parcel-labels`,
  `check-placeholder-packing`; the import ones are `check-import`,
  `check-ebay-seller`, `check-upload-checklist`, `check-report-entry`.

Real export files are never committed — they carry customer names and addresses.
The fixture-driven checks read a folder given in `STREAMOPS_IMPORT_FIXTURES`.

---

## Useful things sitting in Samuel's Downloads

`Inventory - everything still open.docx` (33 questions, with Daniel) ·
`Opening stock count sheet.xlsx` (727 models, ready for the shelf count) ·
`Inventory - the plan and what is still open.docx` (the plan and diagram) ·
`Instructions for when we run a sample show.docx` (for Gladys).
