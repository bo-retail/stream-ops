# Inventory — handover

Everything decided, everything still open, and what to build first. Written so a
new session can pick this up without the conversation that produced it.

Read `CLAUDE.md` first (how work is done here). `WHERE-WE-ARE.md` covers the rest
of the project; this file is inventory only.

**Status on 1 October 2026: steps 1–4 built, on `main`, not pushed.** Step 4 (moves,
adjustments, returns and cancellations, sample prompts, undo) is on Inventory →
Movements, checked by `scripts/check-movements.mts`. Not built from the demo yet: a
scanned cancelled box saying "do not ship" (it is flagged instead), and the prompt to
put samples back when a model is restocked. Neon needs migrations 20261002…20261009.

_Steps 1–3:_
Step 1 (catalogue, counting, pictures), step 2 (receiving: offer, shipping list,
shipment count, differences, still to come, product details) and step 3 (paid
orders come off stock; packing sends them) are committed, each independently
reviewed, and checked by `scripts/check-inventory.mts`, `check-receiving.mts` and
`check-deduction.mts`. 

**Before launch** (step 3 does nothing until a director sets the start date on
Inventory → Sales):
1. Load the master, **every recent offer and shipping list** — on the real 09/27
   day, 683 of 936 watches sold were on the 09.19 offer and not in the master;
   with the offer loaded, all 936 came off.
2. Gladys's opening count, after packing, with sold-not-sent watches set aside.
3. Set the start date to the first show after the count.
4. Get a real report with the `Model #` column (random pulls are named by it; until
   then by the piece scanned at packing). Packing does **not** refuse a wrong
   random-pull watch yet — a mismatch is flagged; switching refusal on is a small
   change once real files carry the column.

_(Was: 30 September — nothing built yet.)_
Daniel has answered five rounds. Sections 1–8 below are the design as of 28
September; **section 0 supersedes them where they differ.** The full working model
of the design is the local demo at `C:\dev\inventory-demo` (`node serve.mjs`,
localhost:4321): its `whatif.mjs` lists 119 situations and how each is handled.

---

## 0. What changed on 29–30 September, and the rules for building

### Decisions since round three
- **New models come from Daniel's offer.** Uploading an offer creates the models
  he ordered (a quantity in `Dani`) that are not yet known, inactive. The shipping
  directors (admins, Claudia, Andres) complete them on a product details sheet
  (description, TP, TikTok weight and box, eBay profile, UPC). Gladys's count makes
  them active. The shipping list is compared with the offer on price and quantity
  ("still to come").
- **Which file says what** (Samuel, 1 October): the offer says *which models,
  how many and at what cost*; the product details sheet says *everything about a
  model*. The offer's brand, collection, gender and picture are copied in only to
  fill blanks on a model it creates. They never overwrite anything, and the
  product details sheet (or its in-app form) always wins.
- **Pictures** (Samuel, 1 October): every model shows its picture on the stock
  list, the model page and the count screen, from the master's `URL` column.
  **Wherever a new product is entered there must be a place to upload its
  picture** — the model page has it now (take or choose a photo, or paste a
  link), and the product details form for offer-created models (step 2) must
  reuse the same picture box. An uploaded photo always wins over the link, so
  a new master never replaces it; it is shrunk in the browser to about 60 KB
  and kept in the database (`ProductPhoto`), no outside storage.
- **The real picture wherever a watch is shown** (Samuel, 1 October): every
  place the demo draws its coloured watch icon beside a model — offers,
  receiving, the show run, slow movers, the morning numbers, every table of
  models — uses the model's real picture instead (`WatchImage`, with
  `picturesFor` for lists keyed by stock number). Already on the inventory
  screens, Sales insights' best sellers, the box log and the packing screen
  (packers see pictures only, fetched beside the scans, never in their way). A placeholder
  listing shows the piece scanned for it where known; diamonds show none.
- **Sold, then sent.** A paid report line makes the watch "sold, waiting to ship"
  (no longer available, still in the building). The packing scan must match the
  report's `model #`; a wrong watch is refused (the packer's mistake; stock does not
  move). A match sends it, and only then does it leave stock. Orders unsent at the
  end of the next day are a warning.
- `model #` is the column name. Every random-pull line has it, and an in-app screen
  is offered too (pending round 6).
- Each watch runs at a **$1 start or a set price** (set price when TP > $120),
  saved per show. Slow movers only count shows where the watch was run.
- A slightly damaged return always goes to random pulls. No lending, only
  giveaways. A platform only refunds once the watch is back. Gladys checks the
  sample trays each morning. Non-watch items are counted. An unknown watch at a
  count is flagged, with options. Bundles come later. UPC is yes.
- The count sheet has **no cost**: cost lives in the master, and only shipments and
  the cost correction template change it.
- The count and the first real shipment come right before launch ("we are starting
  fresh"). Still to receive: the "Correct eBay upload", "TT Upload" and "TT
  Diamonds Upload" templates, and one real report with `model #`.
- **Round 6** (`Downloads\Inventory - last decisions (round 6).docx`) holds
  the last decisions, each with a recommended default. We build on those
  defaults and change any that Daniel answers differently.

### Round 6, answered by Samuel (1 October)
- **Launch:** sales before the count never move stock; from the first show after
  it, everything does. The first real shipment stays boxed until the shelf count
  is done, then is counted as a shipment. Andres's xlookup runs in parallel until
  **Samuel says it stops** (no automatic rule).
- **Every day:** the shelf is counted after the day's packing. "Not sent" is
  flagged at the end of the next day and goes to Samuel after two days.
- **Offers:** only models with a `Dani` quantity are created. Offers are named
  by date; the same date replaces. Not arrived after **60 days** (not 30) drops
  off "still to come" and stays in the history. Cost is set only by the offer,
  the shipping list and the cost correction; product details fill a missing cost
  only.
- **Shows:** a watch counts as run if it sold or was on that show's eBay
  selection or show run.
- **Numbers:** a cost snapshot on every sale; a correction moves the current
  month only, and a closed month gets a correction line; returns go back at the
  cost they left with, booked on the day they come back; damaged stock is valued
  at cost until credited or written off.
- **Upload files:** a set-price watch (TP over $120) goes on eBay as an
  **auction starting at its TP**. TikTok's fixed price will become **50% of
  MSRP** as Invicta sends MSRPs, so MSRP is now a field kept per model (until
  then, $800). One eBay file per show (AM and PM), each with its show tag.
  **The AM and PM TikTok files are both uploaded in the morning.** No Seller SKU
  column on TikTok.
- **Still open:** does an unsold set-price eBay auction end with the show or
  stay up? On TikTok, is a set-price watch's starting bid its TP? How do the AM
  and PM TikTok files split the quantity, when both go up before either show?

### Build rules, from the first line of code
1. **Stock history is append-only.** No hard deletes, and no `onDelete: Cascade`
   into it from ImportBatch, Release, Show or anything else (the 09/22 incident).
   Undo writes reversing entries. It is blocked, with the list shown, once a
   dependent box has been sent.
2. **No doubles.** One deduction per order line, enforced by a unique key. Each
   scan carries its own id, so a retry does nothing twice. Uploads are locked per
   (business, date, platform, slot). One shared function decides which upload is
   current.
3. **Watches only.** Every inventory query filters to watches. Diamond packing
   (`packPlaceholder` is shared) behaves exactly as today, and
   `check-placeholder-packing` stays green.
4. **Scans never move stock on their own.** Reports sell. The packing scan sends,
   and only when it matches. An unrecognised or "Pack it anyway" box is matched to
   its sale by tracking number on upload. Note that `imports.ts` only updates
   *open* boxes today, so a closed unrecognised box needs explicit matching.
   "Mark day sent" refuses while there are unmatched boxes.
5. **Time:** store instants in UTC. The business day comes from the business-zone
   helper, never from UTC midnight.
6. **No separate balance table** (changed 1 October, for simplicity): a model's
   stock in a place is the sum of its ledger lines, worked out when it is read,
   so it can never drift from its own history. Snapshot the cost on every sale.
7. **Permissions by role, not by name** (Samuel, 1 October): admins and shipping
   directors do everything in inventory — counts, stock changes, product
   details, the eBay selection. Packers and streamers see none of it. Log
   everything to AuditLog.
8. **Test from the real files:** the 09.19 offer (427 lines, a duplicate
   "Invicta Model" column, "Distriutor cost", #N/A), the 9.16 shipping list (PO is
   free text), and a real report with `model #`. Plus what-if tests per the review
   rule in `CLAUDE.md`.
9. **Tolerate old rows:** boxes and sales from before launch behave as today.
   Deploy outside packing and upload hours, and tell the floor to refresh.
10. **Backups:** make a Neon branch at launch, and a daily export of balances and
    the ledger after it.
11. **Migration names must sort after `20261003000000`.** Step 1 and the
    photos migration are dated ahead (2 and 3 October), so one made today by
    `prisma migrate dev` would sort before them and run before `Product` exists
    on Neon. Rename every new inventory migration by hand to sort after them.
12. **Every template can also be typed in on the website, and that is the main
    way** (Samuel, 1 October). Each template-based job (full count, spot count,
    shipment count, returns and cancellations, adjustments, moves, cost
    correction, product details) has an in-app form with the same columns, a
    blank template to download from a Templates page on the site (no OneDrive
    copies), and an upload for the filled template. Typed and uploaded entries go
    through one shared checker and one write path, so they behave identically.
    Files that come from outside (sales reports, offers, shipping lists,
    invoices) stay upload-only.

---

## 1. Why

Stock lives in spreadsheets. Every morning **Andres rebuilds the inventory with an
xlookup** of Gladys's sales reports against a `Sellable` column. That job is what
this replaces: stock down when something sells, up when a shipment arrives, and
nobody keeping a second set of numbers.

After inventory comes **profitability**, which needs cost per piece — so the two
are one arc, not two projects.

**Watches only.** Daniel: *"Let's focus only on watches, strictly, strictly
watches right now."* Diamonds later.

---

## 2. The files this was worked out from

All in Samuel's Downloads, all read line by line.

| File | What it is |
|---|---|
| `Invicta Master Products 09.23.26.xlsx` | The catalogue. 727 models, three sheets: Inventory, Sample, Random Pulls Show. Model, brand, PF code, collection, series, gender, description, image URL, TikTok weight and dimensions, eBay shipping profile. |
| `BO Retail 9.16.26 Shipping List.xlsx` | Stock arriving. SOP, PO, item, quantity, unit price. 91 lines, 2,937 pieces, $86,846 at cost, all under SOP INV258905. |
| `INV258905.pdf` | The invoice for that shipment (an image; no extractable text). |
| `Invicta Shipping List Master.xlsx` | Cost per model. 1,254 rows, 1,095 distinct models, no quantities. Four models appear at two prices. |
| `09.19 BO retail offer_.xlsx` | Invicta's offer — **and the "order confirmation" Daniel means**. `OH` = their on-hand, `IT` = in transit, `Dani` = quantity he chose, `Qty` = Invicta's recommendation, `BO COSTS` = our cost. Their stock, never ours. |

Numbers in the catalogue worth knowing: `Sellable` is filled for 207 of 727 models
on the Inventory sheet (6,603 pieces), 289 on Sample (578), 383 on Random Pulls
(799). `TP` is target price, `ASP` average sold price, `US` units sold, `T. Sold`
total sold in dollars — the last two are Invicta's figures, not ours. `Lowest`,
`MSRP`, `TT` and `eBay` are dead columns; ignore them.

---

## 3. What is settled

Daniel answered all 44 of round one and all 18 of round two. These are his
answers, not inferences.

### The shape of stock

- Counted **per model**, not per piece. Seventeen of `TM-222013` is seventeen units.
- A model sits in one of **five places**: sellable, **one sample per platform**
  (eBay and TikTok — a third channel would mean a third sample), random pulls,
  damaged.
- **"Random pulls" is a state, not a monthly event**: a model that has a sample
  but no sellable stock. When sellable hits zero the sample becomes the random-pull
  piece, and **that physical watch ships**. Exception: expensive models (they buy
  ~5) where the sample itself is sold from a normal show.
- Samples are **physically apart** — trays on a table beside the shows, where
  streamers can reach them. Sellable is on shelves, which streamers cannot take from.
- A sample can go back to sellable. Damaged returns go to a damaged warehouse.
- Unsold random pulls stay in random pulls.
- Only Invicta, including its sub-brands (Activa, Montres Prestige).
- One location. There **are** watches on the shelf not in the master file.

### Coming in

- Every shipment arrives with a list in the 9.16 shape. Nothing arrives without one.
- **Gladys's count is the truth, not Invicta's list.** Short → they ship the
  balance; over → they adjust the invoice. Keep her number, flag the difference.
- One shipping list can carry several invoices, but a model never appears twice at
  different prices.
- Was weekly, going to twice weekly. 20–300 SKUs a shipment.
- Nothing is ever sent back to Invicta.
- **Gladys uploads the count** — not Invicta's shipping list.

### Cost

- The shipping-list price is true; so is the order-confirmation (offer) file. The
  catalogue's `Cost` column is just an xlookup of the shipping list.
- **No freight or duty** — Invicta delivers free, so the invoice price is landed cost.
- **Weighted average** where a model was bought at two prices, though Invicta
  always gives the latest price.
- Every model must have a cost. Flag anything without one.

### Going out

- **Stock comes off when an order is paid.**
- On a random-pull sale, believe **the scanned tag**: the scanner reads Invicta's
  own barcode, which **is** the model number (e.g. `48912`). Their sticker is the
  order they sold in, and **restarts at 1 every show** — it identifies nothing.
- Cancelled or returned: sellable back to inventory, slightly damaged to the sample
  pulls, fully damaged to damaged. **The app cannot know about a cancellation** —
  Daniel wants an upload template for it.
- Write-offs and giveaways: content, gift, lost, broken. Recorded by Gladys,
  Andres, Claudia, Flora or Daniel — all five can see and change stock.

### What the system should do

- **eBay caps at 750 units at one time per show**, so before each show they choose
  which models and quantities go to eBay and the rest goes to TikTok. Keep a record
  of each selection.
- Produce the listing files: TikTok with weight and dimensions, eBay with the
  shipping profile. The product template should require that information up front.
- Warn about running low and about slow movers (so the target price can be cut to
  get the cash back). A slow mover is "few units at a very low margin for seven
  consecutive days" — the thresholds are still undefined.
- **Opening count comes from counting the shelf**, starting fresh. The past is let go.
- Andres keeps running his xlookup alongside until the app's count is trusted.
- Morning screen: revenue, COGS, gross margin, ASP, units sold — then total
  expenses and net margin once those exist. Target **$35,000 a day at 35%**, both
  platforms together.

### Profitability, the phase after

- Measured per show (AM/PM), per platform, and overall.
- Revenue − COGS = gross margin; then fees, salary, commission, operating expenses
  → net margin; then other expenses (renovations, credit card fees).
- They make money on shipping on both platforms, and there are "unsettled" reports
  — courier claims that parcels were never handed over. **Flora** holds the report
  with revenue, fees, shipping gains and operating expenses. Salary and commission
  come from StreamOps, which already has hours and commission rates.

---

## 4. The one design problem nobody has solved yet

**Stock comes off when an order is paid, but a random-pull piece is only identified
when it is packed.** On a sample show that is most of the day — on 09/18, 440 of
the pieces sold went out under listings like `#300 - Invicta Random Pulls`, which
carry no model number at all.

So between payment and packing the sale is known but the watch is not. A
random-pull sale needs a **pending** state: revenue at payment, model and cost at
packing. Two things can resolve it — the model-number column Daniel says they will
add to the report, or the scan itself.

Question 1 of round three asks whether that column will **always** be filled. If
yes, stock can come off at payment like everything else and the scan merely
confirms. If not, the sale waits for the packing table. **This is the only open
question that changes the build rather than a detail of it.**

---

## 5. What is still open

`Inventory - everything still open.docx` — 33 questions, with Daniel, each tagged
with the step it holds up. The sections:

- **A. The pending random-pull sale** (3) — the problem above. Also: what if a
  parcel ships without ever being scanned?
- **B. Cancellations and returns** (4) — where a cancellation shows up today, what
  the upload template needs, who uploads it, and whether stock returns when the
  report says so or when Gladys has the watch in her hand.
- **C. Slow movers** (4) — actual numbers for "few units" and "very low margin".
- **D. Receiving** (3) — same-day counting, how a short shipment's balance arrives,
  whether differences stay on screen until settled.
- **E. Samples** (4) — who pulls the two samples and when, whether a sold sample is
  replaced, models that arrive with too few units to split, delisting at zero.
- **F. Cost** (3) — whether `BO COSTS` is always what we pay, which wins if the
  invoice differs, who adds a missing cost.
- **G. The eBay selection** (4) — units or listings, who chooses, TikTok's own cap,
  whether it produces a file.
- **H. The morning numbers** (3) — every day or only show days, per-show split,
  weighted-average COGS.
- **I. Who does what** (2) — read-only versus edit, how often the shelf is recounted.
- **J. Profit phase** (3) — examples of Flora's report, the shipping gains and the
  unsettled claims.

Nothing here stops steps 1–3 except question 1.

---

## 6. The build, in order

| Step | What | Waits on |
|---|---|---|
| 0 | **The count.** `Opening stock count sheet.xlsx` is ready: 727 models pre-filled with description, collection and cost, a column per location, and a second tab for models not in the master file. | — |
| 1 | **Catalogue and stock.** 727 models with cost; the count loaded as the opening balance; stock visible per model. | the count |
| 2 | **Receiving.** Gladys enters what she counted against a shipment; cost captured; differences flagged. The product details form for new models includes the picture upload. | 1 |
| 3 | **Deduction.** Paid orders come off from the reports already uploaded. This is what ends Andres's xlookup. | 1, 2 |
| 4 | **Movements.** Samples pulled, sample → random pulls at zero (ask Gladys first, do not move it silently), returns, damaged, write-offs. | 3 |
| 5 | **The eBay selection.** Choose under the 750 cap, rest to TikTok, export both listing files. | 3 |
| 6 | **Morning numbers.** Revenue, COGS, gross margin, ASP, units against the target. | 3 |
| 7 | **Profitability.** Fees, salary, commission, opex → net margin, plus shipping gains and unsettled claims. | 6 |

Steps 1–3 are the spine. Until stock comes off by itself, the rest is decoration.

---

## 7. What already exists in the app that inventory can stand on

- **Every sale carries a stock number**, and sales are already imported daily with
  business, platform, show, quantity and price (`SalesRecord`).
- **Packing records what physically went out**, including the tag scanned against a
  placeholder listing (`ScanEvent` of kind `ITEM_PLACEHOLDER`). That is how a
  random-pull piece can be identified at all.
- **A placeholder listing is already recognised**: a stock number containing a space
  (`src/lib/domain/imports/placeholders.ts`). `Invicta Random Pulls PM Show` and
  `#300 - Invicta Random Pulls` both qualify, so the packer is already asked to scan
  the piece rather than hunt for a number.
- On 09/18 every real stock number sold was present in both the catalogue and the
  cost list — so costing has no coverage gap to solve, only the placeholder problem.

---

## 8. Documents produced so far

In Samuel's Downloads:

- `Inventory - questions for Daniel.docx` — round one, 44 questions, **answered**.
- `Inventory - the plan and what is still open.docx` — the plan, the diagram, round
  two's 18 questions, **answered**.
- `Inventory - everything still open.docx` — round three, 33 questions, **pending**.
- `Opening stock count sheet.xlsx` — ready for the shelf count.

Memory notes: `inventory-phase` holds the same ground in brief.
