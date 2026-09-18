/**
 * The check either side of migrating production for the two-business release.
 *
 * Every rehearsal of these migrations ran on a copy of the data made on this
 * machine. Production's own data has never been looked at by any of them, and
 * the one migration that rewrites rows — splitting each old whole-day upload
 * into the lines it held — is only as safe as its assumptions about that data.
 * So the assumptions are checked against the real thing, first, and the result
 * is proved afterwards, before any code goes out.
 *
 *   node scripts/launch-check.mjs before     just before the migrations
 *   node scripts/launch-check.mjs after      just after them, before pushing
 *
 * BEFORE records what every day's sales read today — rows, pieces and cents,
 * the way the live site reads them — and checks every assumption the five
 * migrations make. It ends READY or STOP.
 *
 * AFTER reads every day the way the new code will, compares each one with what
 * BEFORE recorded, to the cent, and checks the migrations all landed. It ends
 * SAFE TO PUSH or STOP.
 *
 * Read-only by construction: everything runs inside one READ ONLY transaction,
 * which the database itself refuses to write in, and which is rolled back at
 * the end. It never changes anything, wherever it is pointed.
 */
import "dotenv/config";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { Client } from "pg";

const mode = process.argv[2];
if (mode !== "before" && mode !== "after") {
  console.error("Usage: node scripts/launch-check.mjs before|after");
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Nothing was checked.");
  process.exit(1);
}

/** The five migrations this release adds. */
const NEW = [
  "20260917190000_diamonds_as_shows",
  "20260917230000_upload_checklist",
  "20260918000000_split_whole_day_uploads",
  "20260918010000_dismissed_reports",
  "20260918020000_placeholder_pieces",
];

const FINGERPRINT = "launch-before.json";
const ON_DISK = readdirSync("prisma/migrations", { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

let stop = 0;
let warn = 0;
const ok = (msg) => console.log(`  ok    ${msg}`);
const bad = (msg) => {
  stop++;
  console.log(`  STOP  ${msg}`);
};
const note = (msg) => {
  warn++;
  console.log(`  note  ${msg}`);
};
const info = (msg) => console.log(`        ${msg}`);

const host = new URL(url).hostname;
const local = ["localhost", "127.0.0.1", "::1"].includes(host);
console.log(`\nLaunch check — ${mode.toUpperCase()}`);
console.log(`Database: ${host}  ${local ? "(THIS COMPUTER — not production)" : "(production)"}\n`);

const db = new Client({ connectionString: url });
await db.connect();
// One transaction, READ ONLY: the database refuses any write inside it. One
// transaction also keeps every query on one connection through Neon's pooler.
await db.query("BEGIN TRANSACTION READ ONLY");

const q = async (sql, params = []) => (await db.query(sql, params)).rows;

/** Days as the per-day totals the fingerprint is made of. */
function byDay(rows) {
  const out = {};
  for (const r of rows) {
    out[r.d] = { rows: Number(r.rows), pieces: Number(r.pieces), netCents: Number(r.net), totalCents: Number(r.total) };
  }
  return out;
}

try {
  /* ------------------------------------------------------ the ledger */

  console.log("Migrations");
  const ledger = await q(
    `select migration_name, finished_at, rolled_back_at from _prisma_migrations`,
  );
  const applied = new Set(ledger.filter((r) => r.finished_at && !r.rolled_back_at).map((r) => r.migration_name));
  const failed = ledger.filter((r) => !r.finished_at && !r.rolled_back_at).map((r) => r.migration_name);

  if (failed.length > 0) {
    bad(`a migration is recorded as started but never finished: ${failed.join(", ")}. Do not continue — send this to Claude.`);
  } else {
    ok("no migration is half-applied");
  }

  const older = ON_DISK.filter((n) => !NEW.includes(n));
  const missingOld = older.filter((n) => !applied.has(n));
  if (missingOld.length > 0) {
    bad(`production is missing migrations it should already have: ${missingOld.join(", ")}.`);
  } else {
    ok(`all ${older.length} earlier migrations are recorded`);
  }

  const newApplied = NEW.filter((n) => applied.has(n));

  if (mode === "before") {
    /* ================================================================ BEFORE */

    if (newApplied.length > 0) {
      bad(
        `${newApplied.length} of the new migrations are already applied (${newApplied.join(", ")}). ` +
          `This is not a "before" any more — run "after" instead.`,
      );
    } else {
      ok("none of the five new migrations has run yet");
    }

    console.log("\nWhat the migrations rely on");

    const indexes = await q(
      `select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename in ('Show', 'Availability')`,
    );
    const has = (name) => indexes.some((i) => i.indexname === name);
    for (const name of ["Show_date_platform_slot_key", "Availability_userId_date_slot_key"]) {
      if (has(name)) ok(`the old unique rule "${name}" exists under the name the migration drops`);
      else bad(`the unique rule "${name}" is not there under that name. The migration would not remove it.`);
    }
    // Any other rule that would still allow only one show per slot per day.
    const stray = indexes.filter(
      (i) =>
        /UNIQUE/i.test(i.indexdef) &&
        i.indexname !== "Show_date_platform_slot_key" &&
        /\("date", platform, slot\)|\(date, platform, slot\)/i.test(i.indexdef),
    );
    if (stray.length > 0) {
      bad(`another unique rule on Show would still block a diamond show beside a watch show: ${stray.map((s) => s.indexname).join(", ")}`);
    }

    const settings = await q(`select "streamerCommissionBps" as bps from "Settings" where id = 'singleton'`);
    if (settings.length === 1) {
      ok(`settings row present — watch commission today is ${(settings[0].bps / 100).toFixed(2)}%, and it carries over unchanged`);
    } else {
      note("no settings row — watch commission will start at 1.00% (the default)");
    }

    const shows = await q(`select "show", count(*)::int n from "SalesRecord" group by 1 order by 1`);
    const known = ["TikTok AM", "TikTok PM", "eBay AM", "eBay PM"];
    const odd = shows.filter((s) => !known.includes(s.show));
    if (odd.length > 0) {
      bad(`sales carry show values the split cannot place: ${odd.map((s) => `"${s.show}" x${s.n}`).join(", ")}`);
    } else {
      ok(`every sale names one of the four shows the split understands (${shows.reduce((n, s) => n + s.n, 0)} sales)`);
    }

    const spaced = await q(
      `select to_char(s."showDate", 'YYYY-MM-DD') d, count(*)::int n
         from "SalesRecord" s where s."stockNumber" ~ '\\s' group by 1 order by 1`,
    );
    if (spaced.length > 0) {
      // No watch export has ever carried one; the diamond placeholders do. So
      // these are diamond sales recorded as watches, which the migrations would
      // carry into watch payroll as they stand. Worth stopping to look at.
      bad(
        `sales whose stock number is a sentence — diamond placeholders recorded as watch sales: ` +
          spaced.map((s) => `${s.d} (${s.n})`).join(", ") + `.`,
      );
    } else {
      ok("no diamond placeholder rows among the watch sales — no diamond file was ever loaded as watches");
    }

    const batches = await q(
      `select status::text, count(*)::int n from "ImportBatch" group by 1 order by 1`,
    );
    info(`uploads on record: ${batches.map((b) => `${b.n} ${b.status}`).join(", ") || "none"}`);

    const empty = await q(
      `select count(*)::int n from "ImportBatch" b where b.status = 'OK'
         and not exists (select 1 from "SalesRecord" s where s."batchId" = b.id)`,
    );
    if (empty[0].n > 0) info(`${empty[0].n} good upload(s) hold no sales at all — left exactly as they are`);

    /* ----------------------------------------- what every day reads today */

    console.log("\nWhat every day reads today");

    // Exactly the live site's rule: the newest good upload of each day.
    const today = byDay(
      await q(`
        with newest as (
          select distinct on ("showDate") id, "showDate"
            from "ImportBatch" where status = 'OK'
           order by "showDate", "uploadedAt" desc, id desc)
        select to_char(n."showDate", 'YYYY-MM-DD') d,
               count(s.id) rows, coalesce(sum(s.qty), 0) pieces,
               coalesce(sum(s."netItemPriceCents"), 0) net, coalesce(sum(s."orderTotalCents"), 0) total
          from newest n left join "SalesRecord" s on s."batchId" = n.id
         group by 1 order by 1`),
    );
    const days = Object.keys(today);
    const sum = (k) => Object.values(today).reduce((n, d) => n + d[k], 0);
    ok(`${days.length} day(s) loaded, ${sum("pieces")} pieces, $${(sum("netCents") / 100).toFixed(2)} in item sales`);

    // What the earlier version of the split would have done — every old upload
    // split, newest copy of each line wins. Shown so the reason it was changed
    // is a fact about this data rather than a hypothetical.
    const naive = byDay(
      await q(`
        with lines as (
          select b.id, b."showDate", b."uploadedAt", s.platform::text p,
                 case when s.platform = 'EBAY' then '' when s."show" like '%AM' then 'DAY' else 'NIGHT' end sl
            from "ImportBatch" b join "SalesRecord" s on s."batchId" = b.id
           where b.status = 'OK' group by 1, 2, 3, 4, 5),
        pick as (
          select distinct on ("showDate", p, sl) id, "showDate", p, sl
            from lines order by "showDate", p, sl, "uploadedAt" desc, id desc)
        select to_char(k."showDate", 'YYYY-MM-DD') d,
               count(s.id) rows, coalesce(sum(s.qty), 0) pieces,
               coalesce(sum(s."netItemPriceCents"), 0) net, coalesce(sum(s."orderTotalCents"), 0) total
          from pick k join "SalesRecord" s on s."batchId" = k.id and s.platform::text = k.p
           and (case when s.platform = 'EBAY' then '' when s."show" like '%AM' then 'DAY' else 'NIGHT' end) = k.sl
         group by 1 order by 1`),
    );
    const wouldHaveMoved = days.filter(
      (d) => JSON.stringify(naive[d] ?? { rows: 0, pieces: 0, netCents: 0, totalCents: 0 }) !== JSON.stringify(today[d]),
    );
    if (wouldHaveMoved.length > 0) {
      info(
        `${wouldHaveMoved.length} day(s) would have changed under the earlier version of the split ` +
          `(${wouldHaveMoved.join(", ")}). The version shipping keeps them exactly as they are.`,
      );
    } else {
      info("no day would have changed even under the earlier version of the split");
    }

    if (stop === 0) {
      writeFileSync(FINGERPRINT, JSON.stringify({ host, takenAt: new Date().toISOString(), days: today }, null, 2));
      info(`recorded in ${FINGERPRINT} for "after" to compare against`);
    }
  } else {
    /* ================================================================= AFTER */

    const notYet = NEW.filter((n) => !applied.has(n));
    if (notYet.length > 0) {
      bad(`not every new migration is applied yet: ${notYet.join(", ")}`);
    } else {
      ok("all five new migrations are applied");
    }

    if (!existsSync(FINGERPRINT)) {
      bad(`no ${FINGERPRINT} — "before" has to run first, on this computer, against the same database.`);
      throw new Error("no fingerprint");
    }
    const before = JSON.parse(readFileSync(FINGERPRINT, "utf8"));
    if (before.host !== host) {
      bad(`"before" was taken against ${before.host}, but this is ${host}.`);
    }

    console.log("\nWhat the migrations did");

    const enums = await q(
      `select t.typname, e.enumlabel from pg_type t join pg_enum e on e.enumtypid = t.oid
        where t.typname in ('ImportStatus', 'ScanKind')`,
    );
    for (const [type, label] of [["ImportStatus", "SUPERSEDED"], ["ScanKind", "ITEM_PLACEHOLDER"]]) {
      if (enums.some((e) => e.typname === type && e.enumlabel === label)) ok(`${type} has ${label}`);
      else bad(`${type} is missing ${label}`);
    }

    const idx = await q(`select indexname from pg_indexes where schemaname = 'public' and tablename = 'Show'`);
    if (idx.some((i) => i.indexname === "Show_business_date_platform_slot_key")) ok("a watch show and a diamond show can share a slot");
    else bad("the new unique rule on Show is missing");
    if (idx.some((i) => i.indexname === "Show_date_platform_slot_key")) bad("the old one-show-per-slot rule is still there");

    const rates = await q(
      `select b.business::text, b."streamerCommissionBps" bps, s."streamerCommissionBps" was
         from "BusinessSettings" b left join "Settings" s on s.id = 'singleton' order by 1`,
    );
    const watch = rates.find((r) => r.business === "WATCH");
    const diamond = rates.find((r) => r.business === "DIAMOND");
    if (watch && (watch.was === null || watch.bps === watch.was)) ok(`watch commission unchanged at ${(watch.bps / 100).toFixed(2)}%`);
    else bad(`watch commission is ${watch?.bps} but was ${watch?.was}`);
    if (diamond) ok(`diamond commission set at ${(diamond.bps / 100).toFixed(2)}%`);
    else bad("no diamond commission row");

    const unsplit = await q(
      `select count(*)::int n from "ImportBatch" b where b.status = 'OK' and b.platform is null
          and exists (select 1 from "SalesRecord" s where s."batchId" = b.id)`,
    );
    if (unsplit[0].n === 0) ok("every old upload that holds sales now belongs to a line");
    else bad(`${unsplit[0].n} old upload(s) with sales were not split`);

    const superseded = await q(`select count(*)::int n from "ImportBatch" where status = 'SUPERSEDED'`);
    info(`${superseded[0].n} earlier upload(s) marked as history, exactly as the old site already treated them`);

    /* ------------------------------------- every day, the new code's way */

    console.log("\nEvery day, read the way the new code reads it");

    // Exactly the new rule: the newest good upload of each line of each day.
    const now = byDay(
      await q(`
        with latest as (
          select distinct on (business, "showDate", platform, slot) id, "showDate"
            from "ImportBatch" where status = 'OK'
           order by business, "showDate", platform, slot, "uploadedAt" desc, id desc)
        select to_char(l."showDate", 'YYYY-MM-DD') d,
               count(s.id) rows, coalesce(sum(s.qty), 0) pieces,
               coalesce(sum(s."netItemPriceCents"), 0) net, coalesce(sum(s."orderTotalCents"), 0) total
          from latest l left join "SalesRecord" s on s."batchId" = l.id
         group by 1 order by 1`),
    );

    const allDays = [...new Set([...Object.keys(before.days), ...Object.keys(now)])].sort();
    const zero = { rows: 0, pieces: 0, netCents: 0, totalCents: 0 };
    const moved = allDays.filter((d) => JSON.stringify(before.days[d] ?? zero) !== JSON.stringify(now[d] ?? zero));
    if (moved.length === 0) {
      ok(`all ${allDays.length} day(s) read exactly as before — every sale, every piece, every cent`);
    } else {
      for (const d of moved) {
        const a = before.days[d] ?? zero;
        const b = now[d] ?? zero;
        bad(`${d}: before ${a.pieces} pieces / $${(a.netCents / 100).toFixed(2)}, now ${b.pieces} pieces / $${(b.netCents / 100).toFixed(2)}`);
      }
    }
  }
} catch (error) {
  if (error.message !== "no fingerprint") {
    bad(`the check itself failed: ${error.message}`);
  }
} finally {
  await db.query("ROLLBACK").catch(() => {});
  await db.end();
}

console.log("");
if (stop > 0) {
  console.log(`STOP — ${stop} problem(s) above. Do not ${mode === "before" ? "run the migrations" : "push the code"}. Send a screenshot to Claude.`);
  process.exit(1);
}
console.log(
  mode === "before"
    ? `READY — nothing here stops the migrations.${warn ? ` (${warn} note(s) above to read.)` : ""}`
    : `SAFE TO PUSH — the database is migrated and every day reads exactly as it did.`,
);
