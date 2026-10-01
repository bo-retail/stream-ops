/**
 * The upload screen's answer when one drop holds both businesses.
 *
 * Writes to the database, so it only runs when asked, and only on a local one:
 *
 *   STREAMOPS_DB_TESTS=1 npx vitest run db.test
 */
import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ebayReport, tiktokReport } from "@/lib/domain/imports/synthetic-exports";

const url = process.env.DATABASE_URL ?? "";
const enabled =
  process.env.STREAMOPS_DB_TESTS === "1" && /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);

let actor = { id: "", role: "BOSS" as const };
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/guards", () => ({ requireShippingDirectorOrThrow: async () => actor }));

const DAY = "2021-06-02";
const BEFORE = "2021-06-01";
const DOMAIN = "@upload-db-test.test";

const form = (files: { name: string; text: string }[]) => {
  const f = new FormData();
  for (const file of files) f.append("files", new File([file.text], file.name, { type: "text/csv" }));
  return f;
};

(enabled ? describe : describe.skip)("uploading a morning's files", async () => {
  const { prisma } = await import("@/lib/db");
  const { toDbDate } = await import("@/lib/domain/dates");
  const { uploadReports } = await import("./actions");

  async function clean() {
    const ids = (
      await prisma.importBatch.findMany({
        where: { showDate: { in: [toDbDate(DAY), toDbDate(BEFORE)] } },
        select: { id: true },
      })
    ).map((b) => b.id);
    await prisma.package.deleteMany({ where: { batchId: { in: ids }, scans: { none: {} } } });
    await prisma.importBatch.deleteMany({ where: { id: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: actor.id } });
  }

  beforeAll(async () => {
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
    const boss = await prisma.user.create({
      data: { email: `boss${DOMAIN}`, name: "Upload Test Boss", passwordHash: "x", role: "BOSS" },
    });
    actor = { id: boss.id, role: "BOSS" };
    await clean();
  });

  afterAll(async () => {
    await clean();
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
    await prisma.$disconnect();
  });

  it("takes watches and diamonds in one drop and says what each did", async () => {
    const r = await uploadReports(
      {},
      form([
        { name: "diamond.csv", text: tiktokReport("caratclublive", DAY, 2, "57800002") },
        { name: "watch.csv", text: tiktokReport("vaultshowlive", DAY, 3, "57800001") },
      ]),
    );
    expect(r.error).toBeUndefined();
    expect(r.ok).toMatch(/^Watch: 3 watches in 3 boxes for 2021-06-02\..*Diamond: 2 pieces in 2 boxes/);
    expect(await prisma.auditLog.count({ where: { actorId: actor.id, action: "IMPORT" } })).toBe(2);
  });

  it("keeps a single-business drop's message as it always was", async () => {
    const r = await uploadReports({}, form([{ name: "watch.csv", text: tiktokReport("vaultshowlive", DAY, 3, "57800001") }]));
    expect(r.ok).toMatch(/^3 watches in 3 boxes for 2021-06-02\./);
  });

  it("lets the good half in and names the refused one", async () => {
    // Every diamond row without a stock number: a packer could not scan them.
    const broken = tiktokReport("caratclublive", DAY, 2, "57800003").replace(/,T\d{6},/g, ",,");
    const before = await prisma.auditLog.count({ where: { actorId: actor.id } });
    const r = await uploadReports(
      {},
      form([
        { name: "watch.csv", text: tiktokReport("vaultshowlive", DAY, 3, "57800001") },
        { name: "diamond-broken.csv", text: broken },
      ]),
    );
    expect(r.ok).toMatch(/^Watch: 3 watches in 3 boxes for 2021-06-02\./);
    expect(r.error).toBe("Diamond: nothing was imported. See below.");
    expect(r.flags?.some((f) => /^Diamond: .*no stock number/.test(f.message))).toBe(true);
    const logs = await prisma.auditLog.findMany({
      where: { actorId: actor.id },
      orderBy: { createdAt: "asc" },
      skip: before,
      select: { action: true },
    });
    expect(logs.map((l) => l.action).sort()).toEqual(["IMPORT", "IMPORT_BLOCKED"]);
  });

  it("refuses a single-business drop as one, as it always did", async () => {
    const r = await uploadReports(
      {},
      form([
        { name: "watch.csv", text: tiktokReport("vaultshowlive", DAY, 3, "57800001") },
        // Two whole days of eBay — refused, whichever business it is.
        { name: "e1.csv", text: ebayReport([{ srn: "1", showDay: BEFORE, paidDay: BEFORE }]) },
        { name: "e2.csv", text: ebayReport([{ srn: "2", showDay: DAY, paidDay: DAY }]) },
      ]),
    );
    // All three are the watch account, so this is one upload, refused as one.
    expect(r.error).toBe("Nothing was imported — see below.");
    expect(r.flags?.some((f) => /2 different show days/.test(f.message))).toBe(true);
  });

  it("adds a late eBay order to the day before and tells the uploader", async () => {
    await uploadReports({}, form([{ name: "b.csv", text: ebayReport([{ srn: "11", showDay: BEFORE, paidDay: BEFORE }]) }]));
    const r = await uploadReports(
      {},
      form([
        {
          name: "d.csv",
          text: ebayReport([
            { srn: "21", showDay: DAY, paidDay: DAY },
            { srn: "12", showDay: BEFORE, paidDay: DAY },
          ]),
        },
      ]),
    );
    expect(r.ok).toMatch(/^1 watch in 1 boxes for 2021-06-02/);
    expect(r.flags?.some((f) => /12 sold in the 2021-06-01 show.*added to 2021-06-01's eBay report/.test(f.message))).toBe(true);
  });
});
