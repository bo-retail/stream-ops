/**
 * "Why does this box show fewer watches than the packing slip?" — read only.
 *
 * For each label given: the box and what it expects, every sales line that
 * names the label (in any upload, current or replaced), every line the same
 * buyer bought around that day whatever label it carries, the rows that were
 * set aside for that buyer (cancelled, unpaid), and the day's uploads. Between
 * them they say whether the missing watches are on another show's or day's
 * report, on a report that was replaced, set aside, or on no report at all.
 *
 * Everything runs inside a READ ONLY transaction: the database itself refuses
 * any write, so it is safe to point at production.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/lookup-short-box.mts GFUS01079421757193 9234690422269300248362
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/lookup-short-box.mts      (open boxes that would wait)
 */
import "dotenv/config";
import { prisma } from "../src/lib/db";
import { reportsWaitedOn } from "../src/lib/server/packing";

/*
  With no labels: every open TikTok watch box of the last ten days that would
  say "the slip may list more" once this change is live, and what it would be
  waiting for — so the effect on the floor is known before the deploy.
*/
const labels = process.argv.slice(2).map((s) => s.trim()).filter(Boolean);

const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "-");
const at = (d: Date | null | undefined) => (d ? d.toISOString().replace("T", " ").slice(0, 16) + "Z" : "-");
const fileList = (files: unknown) =>
  Array.isArray(files) ? files.map((f) => (f as { name?: string }).name ?? "?").join(", ") : "";

await prisma.$transaction(
  async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");

    // Which upload is the current one of each line (business, day, platform, slot).
    const currentIds = async (days: Date[]) => {
      const batches = await tx.importBatch.findMany({
        where: { showDate: { in: days }, status: "OK" },
        orderBy: { uploadedAt: "desc" },
        select: { id: true, business: true, showDate: true, platform: true, slot: true },
      });
      const seen = new Set<string>();
      const ids = new Set<string>();
      for (const b of batches) {
        const line = `${b.business}|${day(b.showDate)}|${b.platform}|${b.slot}`;
        if (seen.has(line)) continue;
        seen.add(line);
        ids.add(b.id);
      }
      return ids;
    };

    if (labels.length === 0) {
      const open = await tx.package.findMany({
        where: {
          status: "OPEN",
          platform: "TIKTOK",
          business: "WATCH",
          isUnrecognised: false,
          showDate: { gte: new Date(Date.now() - 10 * 86_400_000) },
        },
        orderBy: [{ showDate: "asc" }, { trackingNumber: "asc" }],
        select: { trackingNumber: true, showDate: true, buyer: true },
      });
      const waiting = new Map<string, number>();
      for (const p of open) {
        const on = await reportsWaitedOn(tx, p.trackingNumber);
        if (on.length === 0) continue;
        const key = `${day(p.showDate)} -> ${on.join("; ")}`;
        waiting.set(key, (waiting.get(key) ?? 0) + 1);
      }
      console.log(`${open.length} open TikTok watch box(es) in the last ten days.`);
      if (waiting.size === 0) console.log("None would be waiting for a report.");
      for (const [key, n] of waiting) console.log(`   ${String(n).padStart(4)} box(es) of ${key}`);
    }

    for (const label of labels) {
      console.log(`\n==================== ${label}`);
      const box = await tx.package.findUnique({
        where: { trackingNumber: label },
        select: {
          id: true, status: true, business: true, platform: true, showDate: true, buyer: true,
          shipToName: true, shipToState: true, isUnrecognised: true, batchId: true, createdAt: true,
          items: { select: { stockNumber: true, expectedQty: true, scannedQty: true }, orderBy: { stockNumber: "asc" } },
          scans: { select: { kind: true, stockNumber: true, at: true }, orderBy: { at: "asc" } },
        },
      });
      if (!box) console.log("No box for this label.");
      else {
        console.log(
          `Box: ${box.status}${box.isUnrecognised ? " (unrecognised label)" : ""}, ${box.business} ${box.platform} ` +
            `day ${day(box.showDate)}, buyer ${box.buyer} / ${box.shipToName} ${box.shipToState}, made ${at(box.createdAt)}, ` +
            `filed under upload ${box.batchId ?? "-"}`,
        );
        for (const i of box.items) console.log(`   ${i.stockNumber.padEnd(16)} expected ${i.expectedQty}, scanned ${i.scannedQty}`);
        console.log(`   ${box.scans.length} scan(s): ${box.scans.map((s) => `${s.kind}${s.stockNumber ? " " + s.stockNumber : ""}`).join("; ")}`);
      }

      const onLabel = await tx.salesRecord.findMany({
        where: { tracking: label },
        orderBy: [{ showDate: "asc" }, { soldAt: "asc" }],
        select: {
          batchId: true, showDate: true, show: true, orderRef: true, buyer: true, stockNumber: true, qty: true,
          soldAt: true, sourceFile: true, sourcePackageId: true,
          batch: { select: { uploadedAt: true, status: true, slot: true, business: true } },
        },
      });
      const labelDays = [...new Set(onLabel.map((r) => day(r.showDate)))];
      const buyers = new Set([...onLabel.map((r) => r.buyer), ...(box?.buyer ? [box.buyer] : [])].filter(Boolean));
      const packageIds = new Set(onLabel.map((r) => r.sourcePackageId).filter(Boolean));

      // Every day in play, and the two either side, so a buyer's earlier orders show up.
      const anchor = onLabel[0]?.showDate ?? box?.showDate ?? null;
      const days: Date[] = [];
      if (anchor) for (let k = -3; k <= 1; k++) days.push(new Date(anchor.getTime() + k * 86_400_000));
      const current = await currentIds(days);

      console.log(`\nSales lines naming this label (${onLabel.length}):`);
      for (const r of onLabel) {
        console.log(
          `   ${day(r.showDate)} ${r.show.padEnd(10)} ${r.stockNumber.padEnd(16)} x${r.qty} order ${r.orderRef} sold ${at(r.soldAt)} ` +
            `pkg ${r.sourcePackageId || "-"} | upload ${r.batchId} ${r.batch.slot ?? ""} ${at(r.batch.uploadedAt)} ` +
            `${current.has(r.batchId) ? "CURRENT" : "replaced"} | ${r.sourceFile}`,
        );
      }

      const theirs = await tx.salesRecord.findMany({
        where: {
          showDate: { in: days },
          OR: [
            { buyer: { in: [...buyers] } },
            ...(packageIds.size > 0 ? [{ sourcePackageId: { in: [...packageIds] } }] : []),
          ],
          NOT: { tracking: label },
        },
        orderBy: [{ showDate: "asc" }, { soldAt: "asc" }],
        select: {
          batchId: true, showDate: true, show: true, orderRef: true, buyer: true, stockNumber: true, qty: true,
          soldAt: true, tracking: true, sourcePackageId: true, sourceFile: true,
          batch: { select: { uploadedAt: true, slot: true } },
        },
      });
      console.log(`\nSame buyer (${[...buyers].join(", ")}), ${day(days[0])} to ${day(days.at(-1))}, on another label or none (${theirs.length}):`);
      for (const r of theirs) {
        console.log(
          `   ${day(r.showDate)} ${r.show.padEnd(10)} ${r.stockNumber.padEnd(16)} x${r.qty} order ${r.orderRef} sold ${at(r.soldAt)} ` +
            `label "${r.tracking}" pkg ${r.sourcePackageId || "-"} | upload ${r.batch.slot ?? ""} ${at(r.batch.uploadedAt)} ` +
            `${current.has(r.batchId) ? "CURRENT" : "replaced"} | ${r.sourceFile}`,
        );
      }

      const drops = await tx.importDrop.findMany({
        where: { buyer: { in: [...buyers] }, batch: { showDate: { in: days } } },
        select: { orderRef: true, stockNumber: true, reason: true, sourceFile: true, batch: { select: { showDate: true, uploadedAt: true } } },
      });
      console.log(`\nSet aside for this buyer (${drops.length}):`);
      for (const d of drops) console.log(`   ${day(d.batch.showDate)} ${d.stockNumber.padEnd(16)} order ${d.orderRef}: ${d.reason} | ${d.sourceFile}`);

      if (labelDays.length > 0 || anchor) {
        const uploads = await tx.importBatch.findMany({
          where: { showDate: { in: days } },
          orderBy: [{ showDate: "asc" }, { uploadedAt: "asc" }],
          select: { id: true, business: true, showDate: true, platform: true, slot: true, status: true, uploadedAt: true, files: true, watchCount: true },
        });
        console.log(`\nUploads ${day(days[0])} to ${day(days.at(-1))}:`);
        for (const u of uploads) {
          console.log(
            `   ${day(u.showDate)} ${u.business} ${String(u.platform ?? "-").padEnd(6)} ${String(u.slot ?? "-").padEnd(8)} ${u.status.padEnd(8)} ` +
              `${at(u.uploadedAt)} ${String(u.watchCount).padStart(4)} watches ${current.has(u.id) ? "CURRENT " : "        "} ${fileList(u.files)}`,
          );
        }
      }
    }
  },
  { timeout: 60_000 },
);
await prisma.$disconnect();
