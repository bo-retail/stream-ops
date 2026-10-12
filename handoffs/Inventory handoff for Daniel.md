# Inventory in StreamOps: handoff for Daniel

*From Samuel, 12 October 2026. Right now we are getting inventory right: do we
have it, a sale takes it away, a return puts it back. Cost and profit come
after that, built on top of it.*

---

## How to use this

1. Give this whole file to your own Claude (paste it in, or attach it).
2. Play with it. Ask your Claude anything, correct what is wrong, and go
   through the questions in section 5 whenever you like.
3. When you are done, ask your Claude to **fill in section 6, "Answers for
   Samuel"**, and send that back to Samuel (the whole conversation is fine too).

Samuel builds the app. You know the business, the Excel files and the way the
team works. This is where the two meet.

### A note for Daniel's Claude

You are helping Daniel, the owner, look at how the StreamOps app keeps inventory.
Let him lead: he may want to explore, ask his own questions, or go through
section 5 in order. Please:

- Keep it plain. Daniel is the expert on the business and its files, not on the app.
- The focus right now is inventory: **do we have it, a sale takes it away, a
  return puts it back.** If Daniel brings up cost, margin, pricing or profit,
  that's welcome. It's where this is heading next, so note what he says under
  "Anything else" in section 6 rather than steering him away.
- When you get to the questions in section 5, each has a default. "Keep the
  default" is a perfectly good answer.
- If Daniel says something in sections 2–4 is wrong, write down exactly what is
  true instead. That matters more than the questions.
- At the end, fill in section 6 in the same format.

---

## 1. The idea in one paragraph

Before StreamOps, stock lived in spreadsheets: every morning Andres rebuilt it
with an xlookup of the sales reports against the `Sellable` column. Now the app
does it. We counted the shelf once (8 October) as the starting point. From then
on **every paid sale takes a watch away, every return or found watch puts one
back, and every delivery adds**. Nobody keeps a second set of numbers. Andres's
xlookup keeps running beside it until we trust the app.

**Watches only.** That was your decision: "strictly watches right now".
Diamonds are packed and shipped through the app, but they are **not** counted
in inventory.

---

## 2. How it works today

### Where a watch can be

Every model is counted **by model number** (17 of `TM-222013` = 17 units), in
one of five places:

| Place | What it is |
|---|---|
| **Sellable** | On the shelves. What normal listings sell from. |
| **Sample eBay** | One sample per platform, on the trays by the shows. |
| **Sample TikTok** | The other platform's sample. |
| **Random pulls** | Samples of models with nothing left on the shelf; that physical watch ships. |
| **Damaged** | The damaged warehouse. |

Plus one holding state that nobody counts: **"Sold, waiting to ship"**. The
watch is paid for, so it is no longer available, but it is still in the
building until its box is packed.

### The starting point: the count (done 8 October)

- The shelf was counted on the count sheet and uploaded on 8 October. That
  count **is** the opening stock. Sales before it never touch stock.
- 62 models on the shelf were not in the master file. They were added
  automatically and are marked "needs details".
- The start date on **Inventory → Sales** is set to 8 October. From then on,
  everything moves stock.

### A sale takes it away (automatic)

1. The morning sales reports are uploaded (TikTok and eBay exports, as today).
2. Each **paid** line takes one watch out of its place and into "sold, waiting
   to ship":
   - A **normal listing** comes off **Sellable**. If Sellable is empty, it
     comes off that platform's sample, then the other platform's sample.
   - A **random pull** comes off **Random pulls** for the model the report's
     `Model #` column names. If that column is blank, the app waits for the
     packer's scan to say which watch it was.
   - If there is none anywhere, it still comes off. The number goes below
     zero and is flagged for the next count to put right.
3. When the packer scans the watch into its box and the box closes, the watch
   is **sent**. It is gone from the building.

The same report uploaded twice never takes a watch twice.

### A cancellation puts it back

- **Cancelled before it shipped:** when the corrected report is uploaded, the
  cancelled order is no longer a paid line, so the watch goes **back to where
  it came from** automatically.
- **Anything the report cannot show**, or a cancellation after packing: entered
  by hand as a return (below).

### A return puts it back (entered by hand, once the watch is in hand)

On **Inventory → Movements → Returns and cancellations** (typed on the site, or
uploaded on the template). One line per return:

| Column | Meaning |
|---|---|
| Model # | The watch |
| Quantity | Usually 1 |
| Type | **Back in stock**, **Exchange / reship** (a watch goes out with no new sale), or **Refund only** (no watch came back) |
| Goes to | **Sellable**, **Random pulls** (slightly damaged, always, as you decided), or **Damaged** |
| Order # | The order it came from |
| Condition / note | Free text |

Stock only comes back when the watch is physically back, not when the platform
says a return is on its way.

### Other changes by hand (Inventory → Movements)

- **Moves** between places, which do not change the total: sample pulled,
  sample back to shelf, sample damaged, replacement sample, sample to random
  pulls, random pull back to shelf.
- **Adjustments**, with a reason from your list:
  - **Takes away:** Damaged, Owner gift, Content, Giveaway, Lost, Direct sale,
    Written off / credited.
  - **Adds:** Found.
  - **Either way:** Miscount.
- **Recounts**: a full or spot count on **Inventory → Count** sets the number to
  what is actually on the shelf.
- **Undo**: anything entered by hand can be undone. Nothing is ever deleted;
  an undo is a new line that reverses it.

### Deliveries add (Inventory → Receiving)

1. **The offer** (e.g. "09.19 BO retail offer") is uploaded. Models you ordered
   (a quantity in `Dani`) that we don't have yet are created.
2. **The shipping list** (e.g. "BO Retail 9.16.26 Shipping List") is uploaded:
   what Invicta says is coming.
3. **The shipment is counted** when it arrives. **The count is the truth**, not
   Invicta's list. Differences are flagged, and anything ordered that has not
   arrived shows as "still to come".

### Who can do what

Admins and shipping directors can do everything in inventory. Packers and
streamers see none of it.

---

## 3. Your files, and what each one does in the app

Samuel never worked on this side, so **please correct anything wrong here**.

| File | What the app takes from it |
|---|---|
| **Invicta Master Products** (Inventory / Sample / Random Pulls sheets) | The catalogue: every model and its details. Loaded once at launch. |
| **Count sheet** | The shelf count: the starting stock (8 October), and any recount after. |
| **Offer** ("09.19 BO retail offer") | Which new models were ordered, and how many (`Dani` column). |
| **Shipping list** ("9.16.26 Shipping List") | What Invicta is sending, before it arrives. |
| **TikTok "All order" export** | The day's TikTok sales (one file per watch show; diamonds send one file for the whole day). |
| **eBay orders export** | The day's eBay sales. |
| **Andres's xlookup** | Not used by the app. Runs alongside as a check until you say stop. |

---

## 4. What the app does *not* do yet (on purpose)

- **Diamonds** are not in inventory.
- A wrong random-pull watch scanned at packing is **flagged, not refused**. That
  waits for reports that always fill the `Model #` column.
- A cancelled order's box is **flagged** at packing; it does not yet say
  "do not ship".
- When a model is restocked, the app does not yet prompt anyone to put its
  samples back.

---

## 5. Questions for you

Each has a default: what the app does now, or what we will do if you say
nothing.

**The count and trust**

1. **Do the app's numbers match reality?** If you or Andres have compared the
   app's stock with his xlookup since 8 October, how close were they, and which
   models were off? *Default: keep both running.*
2. **When does Andres's xlookup stop?** *Default: only when you say so.*
3. **How often is the shelf recounted, and by whom?** A full count, or spot
   counts of some models? *Default: a spot count when a number looks wrong.*

**Sales taking stock away**

4. **Is the `Model #` column filled on every random-pull line of the sales
   report?** If it always is, stock comes off at payment and the app can refuse
   a wrong watch at packing. If not, it waits for the scan. *Default: wait for
   the scan when it's blank.*
5. **Can a normal listing really sell its sample when the shelf is empty**
   (Sellable, then that platform's sample, then the other's)? *Default: yes, as
   now.*

**Returns and cancellations putting stock back**

6. **Who enters returns, and when?** *Default: Gladys, once the watch is in hand.*
7. **Where does a returned watch go?** Undamaged to Sellable, slightly damaged
   to Random pulls, broken to Damaged. Is that still right? *Default: yes.*
8. **Cancellations after packing.** When an order is cancelled but the box
   already went, or was about to: who tells the floor, and who enters it?
   *Default: entered as a return when the watch is back.*
9. **Exchanges and reships.** When a buyer gets a replacement watch, the app
   takes it from Sellable, or from a sample if the shelf is empty, never from
   Random pulls. Is that right? *Default: yes.*

**Deliveries**

10. **Who counts a shipment when it arrives, and is it the same day?**
    *Default: Gladys, same day.*
11. **Is every delivery's shipping list uploaded,** or only some? *Default: every one.*

**Everything else**

12. **The 62 models found on the shelf that were not in the master.** Who fills
    in their details, and should any of them not be sold? *Default: the shipping
    directors complete them.*
13. **Diamonds:** keep them out of inventory for now? *Default: yes, watches only.*
14. **Anything about how stock really moves that this file gets wrong or leaves
    out:** watches lent, moved between locations, sold off the books, or kept
    for content.

---

## 6. Answers for Samuel

*(Daniel's Claude: fill this in at the end. Keep each answer to a line or two.
Write "default" where Daniel kept the default.)*

```
CORRECTIONS TO SECTIONS 2–4 (what is actually true):
-

ANSWERS:
1. Numbers match reality:
2. When the xlookup stops:
3. Recounts:
4. Model # always filled:
5. Selling from samples:
6. Who enters returns, when:
7. Where returns go:
8. Cancellations after packing:
9. Exchanges / reships:
10. Counting deliveries:
11. Shipping lists uploaded:
12. The 62 new models:
13. Diamonds in inventory:
14. Anything missing:

ANYTHING ELSE DANIEL WANTS SAMUEL TO KNOW:
-
```
