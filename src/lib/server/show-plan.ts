import "server-only";
import { prisma } from "@/lib/db";
import { addDays, toDbDate } from "@/lib/domain/dates";
import { isPlaceholderStock } from "@/lib/domain/imports/placeholders";
import { normaliseStockNumber } from "@/lib/domain/imports/tracking";
import { normaliseModel } from "@/lib/domain/inventory";
import {
  FILE_KEYS,
  checkPlan,
  ebayRows,
  fitToStock,
  missingForEbay,
  missingForTiktok,
  propose,
  tiktokRows,
  type FileKey,
  type Issued,
  type PlanCandidate,
  type PlanChoice,
  type PlanLine,
  type PlanProduct,
  type Show,
} from "@/lib/domain/show-plan";
import type { DateISO } from "@/lib/domain/types";
import { pictureFor } from "@/lib/domain/watch-images";
import type { Prisma } from "@/generated/prisma/client";
import { getStartDate } from "./deduction";
import { balancesFor } from "./inventory";
import { listingFile } from "./listing-files";
import { latestBatchIds } from "./sales-data";

/**
 * The day's plan, server side: this morning's shelf, last week's sales, the
 * day's published schedule, the plan saved for the day and the files already
 * downloaded from it.
 *
 * Watches only: every product is a watch, and the sales, shows and reports
 * read here are filtered to the watch business.
 */

export interface PlanRow extends PlanCandidate {
  picture: string;
  /** What it lacks for each platform; empty when ready. */
  missingEbay: string[];
  missingTiktok: string[];
}

/** A file downloaded: when, by whom, and what it listed per model. */
export interface FileOut {
  at: string;
  by: string | null;
  lines: Record<string, number>;
  /** The models it listed at a set price, so downloading it again gives the same prices. */
  set?: string[];
}
export type FilesOut = Partial<Record<FileKey, FileOut>>;

export interface PlanDay {
  date: DateISO;
  rows: PlanRow[];
  /** Which eBay shows are on the published schedule for the day. */
  shows: Record<Show, boolean>;
  /** The suggestion, per model. */
  proposal: Record<string, { AM: number; PM: number }>;
  saved: { version: number; savedAt: Date; savedBy: string | null; choices: PlanChoice[] } | null;
  /** The files already downloaded. */
  files: FilesOut;
  /** The saved plan laid over the shelf as it is now: what the files hold. */
  current: PlanLine[];
  /** Where the shelf no longer covers the saved plan. */
  cuts: string[];
  /** Models the files already out list more of than is on the shelf. */
  overListed: string[];
  /** Yesterday's shows whose report is not uploaded yet. */
  missingReports: string[];
  /** The first show day whose sales come off stock, or null while that is off. */
  startDate: DateISO | null;
}

const issuedFrom = (files: FilesOut): Issued =>
  Object.fromEntries(FILE_KEYS.filter((k) => files[k]).map((k) => [k, files[k]!.lines]));

const readFiles = (json: Prisma.JsonValue): FilesOut => (json && typeof json === "object" && !Array.isArray(json) ? (json as unknown as FilesOut) : {});

const PRODUCT_SELECT = {
  id: true, model: true, description: true, imageUrl: true, costCents: true, tpCents: true, msrpCents: true,
  weightLb: true, lengthIn: true, widthIn: true, heightIn: true, ebayShippingProfile: true,
} as const;

type ProductRow = { model: string; description: string; imageUrl: string; costCents: number | null; tpCents: number | null; msrpCents: number | null; weightLb: number | null; lengthIn: number | null; widthIn: number | null; heightIn: number | null; ebayShippingProfile: string };

const asPlanProduct = (p: ProductRow): PlanProduct => ({
  model: p.model, description: p.description, imageUrl: p.imageUrl, costCents: p.costCents, tpCents: p.tpCents,
  msrpCents: p.msrpCents, weightLb: p.weightLb, lengthIn: p.lengthIn, widthIn: p.widthIn, heightIn: p.heightIn,
  ebayShippingProfile: p.ebayShippingProfile,
});

/** Every model on the shelf this morning, with what the plan and the files need. */
async function candidates(date: DateISO): Promise<PlanRow[]> {
  const products = await prisma.product.findMany({
    where: { active: true },
    select: { ...PRODUCT_SELECT, photo: { select: { updatedAt: true } } },
  });
  const balances = await balancesFor(prisma);
  const sold = await soldLastWeek(date);
  const rows: PlanRow[] = [];
  for (const p of products) {
    const available = balances.get(p.id)?.SELLABLE ?? 0;
    if (available <= 0) continue;
    const product = asPlanProduct(p);
    rows.push({
      ...product,
      available,
      soldLast7: sold.get(p.model) ?? 0,
      picture: pictureFor(p.model, p.imageUrl, p.photo?.updatedAt),
      missingEbay: missingForEbay(product),
      missingTiktok: missingForTiktok(product),
    });
  }
  return rows.sort((a, b) => a.model.localeCompare(b.model));
}

/**
 * Watch units sold per model over the seven days before `date`, from the
 * current uploads only, named the way stock deduction names them: a stock
 * number is that model; a random-pull listing is the watch its `Model #`
 * names, one per unit ("40022;45802").
 */
async function soldLastWeek(date: DateISO): Promise<Map<string, number>> {
  const batchIds = await latestBatchIds(addDays(date, -7), addDays(date, -1));
  const out = new Map<string, number>();
  if (batchIds.length === 0) return out;
  const sales = await prisma.salesRecord.findMany({
    where: { batchId: { in: batchIds }, business: "WATCH" },
    select: { stockNumber: true, modelNumber: true, qty: true },
  });
  const add = (model: string, n: number) => model && out.set(model, (out.get(model) ?? 0) + n);
  for (const s of sales) {
    if (!isPlaceholderStock(s.stockNumber)) {
      add(normaliseStockNumber(s.stockNumber), s.qty);
      continue;
    }
    const named = s.modelNumber.split(/[;,/]/).map(normaliseModel).filter(Boolean);
    for (let unit = 0; unit < Math.max(1, s.qty); unit++) add(named[unit] ?? named[0] ?? "", 1);
  }
  return out;
}

/** The day's watch shows on the published schedule; a draft schedule is not the day's yet. */
const publishedShows = (date: DateISO, extra: Prisma.ShowWhereInput = {}) =>
  prisma.show.findMany({
    where: { business: "WATCH", date: toDbDate(date), status: "SCHEDULED", release: { scheduleStatus: "PUBLISHED" }, ...extra },
    select: { platform: true, slot: true },
  });

/** Which watch eBay shows the day's schedule has. */
async function ebayShows(date: DateISO): Promise<Record<Show, boolean>> {
  const shows = await publishedShows(date, { platform: "EBAY" });
  return { AM: shows.some((s) => s.slot === "DAY"), PM: shows.some((s) => s.slot === "NIGHT") };
}

/**
 * Yesterday's watch shows whose report is not in yet. Until they are, this
 * morning's shelf still counts what sold yesterday, and the plan would offer
 * watches that are already sold.
 */
async function missingReportsFor(date: DateISO): Promise<string[]> {
  return missingReportsOn(addDays(date, -1));
}

/** A show day's published watch shows whose report is not uploaded. */
export async function missingReportsOn(day: DateISO): Promise<string[]> {
  const [shows, batches] = await Promise.all([
    publishedShows(day),
    prisma.importBatch.findMany({
      where: { business: "WATCH", showDate: toDbDate(day), status: "OK" },
      select: { platform: true, slot: true },
    }),
  ]);
  const missing: string[] = [];
  for (const s of shows) {
    // eBay's one export covers the whole day; TikTok has one per show.
    const found = s.platform === "EBAY"
      ? batches.some((b) => b.platform === "EBAY")
      : batches.some((b) => b.platform === "TIKTOK" && b.slot === s.slot);
    const label = s.platform === "EBAY" ? "eBay" : `TikTok ${s.slot === "DAY" ? "AM" : "PM"}`;
    if (!found && !missing.includes(label)) missing.push(label);
  }
  return missing;
}

async function savedPlan(date: DateISO) {
  const plan = await prisma.showPlan.findUnique({
    where: { date: toDbDate(date) },
    select: {
      version: true, savedAt: true, files: true, savedBy: { select: { name: true } },
      lines: { select: { ebayAm: true, ebayPm: true, setPrice: true, product: { select: { model: true } } } },
    },
  });
  if (!plan) return null;
  return {
    version: plan.version,
    savedAt: plan.savedAt,
    savedBy: plan.savedBy?.name ?? null,
    files: readFiles(plan.files),
    choices: plan.lines.map((l) => ({ model: l.product.model, AM: l.ebayAm, PM: l.ebayPm, setPrice: l.setPrice })),
  };
}

export async function getPlanDay(date: DateISO): Promise<PlanDay> {
  const [rows, shows, saved, missingReports, startDate] = await Promise.all([
    candidates(date), ebayShows(date), savedPlan(date), missingReportsFor(date), getStartDate(),
  ]);
  const files = saved?.files ?? {};
  const { lines, cuts, overListed } = fitToStock(saved?.choices ?? [], rows, issuedFrom(files));
  return {
    date,
    rows,
    shows,
    proposal: Object.fromEntries(propose(rows, shows)),
    saved: saved ? { version: saved.version, savedAt: saved.savedAt, savedBy: saved.savedBy, choices: saved.choices } : null,
    files,
    current: lines,
    cuts: saved ? cuts : [],
    overListed,
    missingReports,
    startDate,
  };
}

export type SavePlanResult = { ok: true; version: number; summary: string } | { ok: false; problems: string[] };

class Refused extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join(" "));
  }
}
const CONFLICT = "Somebody else saved this day's plan while you were working on it. Open the page again to see it; nothing of yours was saved.";

type Tx = Prisma.TransactionClient;
/** Holds the day's plan row until the end of the transaction, so a save and a download never cross. */
async function lockPlan(tx: Tx, date: DateISO) {
  await tx.$queryRaw`SELECT id FROM "ShowPlan" WHERE date = ${toDbDate(date)}::date FOR UPDATE`;
  return tx.showPlan.findUnique({
    where: { date: toDbDate(date) },
    select: { id: true, version: true, files: true, lines: { select: { ebayAm: true, ebayPm: true, setPrice: true, product: { select: { model: true } } } } },
  });
}

/**
 * Saves the day's plan, checked against the shelf as it is now and the files
 * already downloaded (their numbers cannot change).
 *
 * `version` is the one the person's screen was showing (null for a day with no
 * plan yet). If somebody else saved or downloaded a file in between, nothing
 * is written and they are told, rather than one plan silently replacing the
 * other.
 */
export async function savePlan(userId: string, date: DateISO, version: number | null, choices: PlanChoice[]): Promise<SavePlanResult> {
  const rows = await candidates(date);
  const normalised = choices.map((c) => ({ ...c, model: normaliseModel(c.model) }));
  const ids = new Map(
    (await prisma.product.findMany({ where: { model: { in: rows.map((r) => r.model) } }, select: { id: true, model: true } }))
      .map((p) => [p.model, p.id]),
  );
  const available = new Map(rows.map((r) => [r.model, r.available]));

  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await lockPlan(tx, date);
      if ((existing?.version ?? null) !== version) throw new Refused([CONFLICT]);
      const { lines, problems } = checkPlan(normalised, rows, undefined, issuedFrom(readFiles(existing?.files ?? {})));
      if (problems.length > 0) throw new Refused(problems);

      let planId: string;
      let next: number;
      if (existing) {
        await tx.showPlan.update({ where: { id: existing.id }, data: { version: { increment: 1 }, savedById: userId, savedAt: new Date() } });
        await tx.showPlanLine.deleteMany({ where: { planId: existing.id } });
        planId = existing.id;
        next = existing.version + 1;
      } else {
        const created = await tx.showPlan.create({ data: { date: toDbDate(date), savedById: userId }, select: { id: true } });
        planId = created.id;
        next = 1;
      }
      // Every model on the shelf, so a choice of "$1 start" on a watch held
      // back today is still there when it is ready.
      await tx.showPlanLine.createMany({
        data: lines.map((l) => ({
          planId, productId: ids.get(l.model)!, ebayAm: l.AM, ebayPm: l.PM, tiktok: l.tiktok, setPrice: l.setPrice,
          available: available.get(l.model) ?? 0,
        })),
      });
      const totals = { AM: 0, PM: 0, tiktok: 0 };
      for (const l of lines) {
        totals.AM += l.AM;
        totals.PM += l.PM;
        totals.tiktok += l.tiktok;
      }
      const summary = `Plan for ${date}: ${totals.AM} on AM eBay, ${totals.PM} on PM eBay, ${totals.tiktok} on TikTok.`;
      await tx.auditLog.create({
        data: {
          entityType: "ShowPlan", entityId: planId, action: existing ? "SHOW_PLAN_CHANGED" : "SHOW_PLAN_SAVED", actorId: userId,
          summary,
          before: existing ? existing.lines.filter((l) => l.ebayAm + l.ebayPm > 0 || l.setPrice).map((l) => [l.product.model, l.ebayAm, l.ebayPm, l.setPrice]) : undefined,
          after: lines.filter((l) => l.AM + l.PM > 0 || l.setPrice).map((l) => [l.model, l.AM, l.PM, l.setPrice]),
        },
      });
      return { ok: true as const, version: next, summary };
    }, { timeout: 60_000, maxWait: 15_000 });
  } catch (e) {
    if (e instanceof Refused) return { ok: false, problems: e.problems };
    // Two first saves of the same day at once: the second hits the unique date.
    const unique = typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === "P2002";
    if (unique) return { ok: false, problems: [CONFLICT] };
    throw e;
  }
}

export type PlanFileKind = "ebay-am" | "ebay-pm" | "tiktok";
const FILE_OF: Record<PlanFileKind, FileKey> = { "ebay-am": "AM", "ebay-pm": "PM", tiktok: "tiktok" };

/**
 * One of the day's upload files. Null when the day has no saved plan: a file
 * made from the suggestion alone could put the same watch on eBay and TikTok.
 *
 * The first download fixes what the file lists (it may be on the platform
 * minutes later); downloading it again gives the same file. What it listed is
 * then taken off what the other files can have.
 */
export async function planFile(userId: string, date: DateISO, kind: PlanFileKind): Promise<{ bytes: Uint8Array; name: string; rows: number; again: boolean } | null> {
  const key = FILE_OF[kind];
  const rows = await candidates(date);
  const result = await prisma.$transaction(async (tx) => {
    const plan = await lockPlan(tx, date);
    if (!plan) return null;
    const files = readFiles(plan.files);
    const choices = plan.lines.map((l) => ({ model: l.product.model, AM: l.ebayAm, PM: l.ebayPm, setPrice: l.setPrice }));
    const { lines } = fitToStock(choices, rows, issuedFrom(files));
    if (files[key]) {
      // Files from before prices were kept take the plan's.
      const set = files[key]!.set ?? lines.filter((l) => l.setPrice).map((l) => l.model);
      return { planId: plan.id, listed: files[key]!.lines, set, again: true };
    }
    const listed = Object.fromEntries(lines.map((l) => [l.model, key === "tiktok" ? l.tiktok : l[key]] as const).filter(([, n]) => n > 0));
    const set = lines.filter((l) => l.setPrice && listed[l.model]).map((l) => l.model);
    const user = await tx.user.findUnique({ where: { id: userId }, select: { name: true } });
    files[key] = { at: new Date().toISOString(), by: user?.name ?? null, lines: listed, set };
    await tx.showPlan.update({ where: { id: plan.id }, data: { files: files as unknown as Prisma.InputJsonValue } });
    return { planId: plan.id, listed, set, again: false };
  }, { timeout: 60_000, maxWait: 15_000 });
  if (!result) return null;

  // The file is exactly what was fixed at its first download; the details of a
  // model no longer on the shelf are read from the catalogue.
  const setPrice = new Set(result.set);
  const models = Object.keys(result.listed);
  const products = new Map<string, PlanProduct>(
    (await prisma.product.findMany({ where: { model: { in: models } }, select: PRODUCT_SELECT })).map((p) => [p.model, asPlanProduct(p)]),
  );
  const fileLines: PlanLine[] = models.map((m) => ({
    model: m, AM: key === "AM" ? result.listed[m] : 0, PM: key === "PM" ? result.listed[m] : 0,
    tiktok: key === "tiktok" ? result.listed[m] : 0, setPrice: setPrice.has(m),
  }));
  const [mm, dd, yy] = [date.slice(5, 7), date.slice(8, 10), date.slice(2, 4)];
  const fileRows = key === "tiktok" ? tiktokRows(fileLines, products) : ebayRows(fileLines, products, date, key);
  const name = key === "tiktok" ? `TikTok upload ${mm}.${dd}.${yy}.xlsx` : `eBay upload ${mm}.${dd}.${yy} ${key}.xlsx`;
  const bytes = await listingFile(key === "tiktok" ? "tiktok" : "ebay", fileRows);
  await prisma.auditLog.create({
    data: { entityType: "ShowPlan", entityId: result.planId, action: "SHOW_PLAN_FILE", actorId: userId, summary: `${name}: ${fileRows.length} rows${result.again ? " (downloaded again)" : ""}.` },
  });
  return { bytes, name, rows: fileRows.length, again: result.again };
}

/**
 * Frees a downloaded file whose numbers turned out wrong — only for a file
 * that was NOT uploaded to the platform. Its numbers can then be changed and
 * the file downloaded again.
 */
export async function releaseFile(userId: string, date: DateISO, key: FileKey): Promise<{ ok: boolean; message: string }> {
  return prisma.$transaction(async (tx) => {
    const plan = await lockPlan(tx, date);
    const files = readFiles(plan?.files ?? {});
    if (!plan || !files[key]) return { ok: false, message: "That file has not been downloaded." };
    const was = files[key]!;
    delete files[key];
    await tx.showPlan.update({ where: { id: plan.id }, data: { files: files as unknown as Prisma.InputJsonValue } });
    await tx.auditLog.create({
      data: {
        entityType: "ShowPlan", entityId: plan.id, action: "SHOW_PLAN_FILE_RELEASED", actorId: userId,
        summary: `${key === "tiktok" ? "TikTok" : `${key} eBay`} file for ${date} marked as not uploaded (downloaded ${was.at}${was.by ? ` by ${was.by}` : ""}).`,
        before: was.lines as unknown as Prisma.InputJsonValue,
      },
    });
    return { ok: true, message: `The ${key === "tiktok" ? "TikTok" : `${key} eBay`} file is free again: change the plan, save, and download it again.` };
  }, { timeout: 30_000, maxWait: 15_000 });
}
