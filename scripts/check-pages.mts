/**
 * Walk every page, as every position, in a real browser.
 *
 * Signs in through the real /login form as an admin, the shipping director, a
 * packer and a streamer, opens every item in that position's menu (the same
 * list the menu is drawn from, `src/app/(app)/nav.ts`), and fails a page on:
 *
 *   - an HTTP error, or ending up somewhere other than the page asked for
 *   - the app's error screen, or Next's "page could not be found"
 *   - an error in the browser console, or an uncaught error on the page
 *   - the whole page scrolling sideways, on a phone (375 px) or a laptop (1366 px)
 *
 * Then, for everyone but the admin, it tries every page in somebody else's menu
 * and fails unless they are sent back to their dashboard. And signed out,
 * /dashboard must go to the sign-in page.
 *
 * The four accounts are made for this run and deleted at the end, together
 * with anything they caused. Their password is generated per run and never
 * printed. Accounts a killed run left behind are removed by the first run more
 * than half an hour later. It refuses to run against anything but a local
 * database.
 *
 * It starts its own development server on port 3217 and stops it afterwards.
 * To walk a server that is already running instead (it must use the same
 * local database):
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/check-pages.mts
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/check-pages.mts --base http://localhost:3000
 *
 * Uses the Chrome installed on this computer (Playwright's `channel: "chrome"`),
 * so no browser is downloaded. Nothing leaves the computer.
 */
import "dotenv/config";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chromium } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth/password";
import { bringStockUpToDate } from "../src/lib/server/deduction";
import { getSettings } from "../src/lib/server/settings";
import { NAV } from "../src/app/(app)/nav";
import { positionToFields } from "../src/app/(app)/admin/team/position";
import type { Position } from "../src/app/(app)/admin/team/position";

assertDevDatabase("check-pages");

const PORT = 3217;
const baseArg = process.argv.indexOf("--base");
const OWN_SERVER = baseArg === -1;
const BASE = OWN_SERVER ? `http://localhost:${PORT}` : process.argv[baseArg + 1]?.replace(/\/$/, "");
if (!BASE) {
  console.error("--base needs an address, e.g. --base http://localhost:3000");
  process.exit(1);
}

/** A development server compiles each page on its first visit, which can take a while. */
const PAGE_TIMEOUT = 120_000;
/** Laptop first (the page as loaded), then a phone. */
const WIDTHS = [1366, 375] as const;

/** Every account this check makes is named like this, so a run that crashed is cleaned up by the next. */
const EMAIL_PREFIX = "pagecheck-";
const EMAIL_DOMAIN = "@streamops.test";

/**
 * Pages a position must not open: every page in anybody's menu that is not in
 * theirs. Built from the menus, so a new admin page is covered the day it is
 * added. Each one should send them back to their dashboard.
 */
function forbidden(position: Position): string[] {
  // The admin may open anything, theirs in the menu or not (see the guards).
  if (position === "ADMIN") return [];
  const own = new Set(NAV[position].map((n) => n.href));
  const all = new Set(Object.values(NAV).flatMap((items) => items.map((n) => n.href)));
  return [...all].filter((href) => !own.has(href));
}

/**
 * Inventory's own pages, opened as the admin on top of the menu.
 *
 * Only the ones in use. Count, sales, morning, movements, plan, receiving and
 * templates send everyone back to /inventory while `INVENTORY_SIMPLE` is on
 * (`src/lib/domain/features.ts`); add them here if that is ever turned off.
 */
const ADMIN_EXTRA = ["/inventory/receive", "/inventory/returns", "/inventory/start"];

/**
 * Headings of the app's own error screen (`src/app/error.tsx`) and Next's
 * missing page. Matched against headings only, so a note in the activity log
 * that happens to say "something went wrong" is not mistaken for one.
 */
const ERROR_SCREEN = [
  "Something went wrong",
  "Can't reach the database",
  "Can’t reach the database",
  "The database isn't running",
  "The database isn’t running",
  "This page could not be found",
  "Application error",
];

const POSITIONS: Position[] = ["ADMIN", "SHIPPING_DIRECTOR", "SHIPPING", "STREAMER"];
const LABEL: Record<Position, string> = {
  ADMIN: "admin",
  SHIPPING_DIRECTOR: "director",
  SHIPPING: "packer",
  STREAMER: "streamer",
};

interface Row {
  who: string;
  page: string;
  ok: boolean;
  detail: string;
}
const rows: Row[] = [];
function record(who: string, page: string, problems: string[]) {
  rows.push({ who, page, ok: problems.length === 0, detail: problems.join("; ") });
}

/* -------------------------------------------------------------------------- */
/* Accounts                                                                   */
/* -------------------------------------------------------------------------- */

const run = randomBytes(4).toString("hex");
// Random, long, and nothing on the "too easy" list. Held in memory only.
const password = `Pc-${randomBytes(18).toString("base64url")}`;

/**
 * Removes this check's accounts, and what each one caused.
 *
 * `onlyStale` is for the start of a run: it clears accounts a crashed run left
 * behind without taking those of a run still going in another window.
 *
 * Audit rows are deleted only when they are *about* the accounts. A row the
 * account merely acted in — opening Inventory brings stock up to date and logs
 * it — records something real that stays done, so it is kept, and deleting the
 * user leaves its actor blank (as for the stock moves and sales, all
 * `onDelete: SetNull`).
 */
async function removeCheckAccounts(which: { run: string } | { onlyStale: true }): Promise<number> {
  const users = await prisma.user.findMany({
    where:
      "run" in which
        ? { email: { startsWith: EMAIL_PREFIX, endsWith: `-${which.run}${EMAIL_DOMAIN}` } }
        : { email: { startsWith: EMAIL_PREFIX, endsWith: EMAIL_DOMAIN }, createdAt: { lt: new Date(Date.now() - 30 * 60_000) } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return 0;

  // Hours printed for them, and the history of those hours. A revision names
  // who changed it without a cascade, so it is what blocks deleting a user.
  await prisma.timeEntryRevision.deleteMany({
    where: { OR: [{ changedById: { in: ids } }, { timeEntry: { userId: { in: ids } } }] },
  });
  await prisma.timeEntry.deleteMany({ where: { userId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { entityType: "User", entityId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  return ids.length;
}

async function makeAccount(position: Position) {
  return prisma.user.create({
    data: {
      email: `${EMAIL_PREFIX}${LABEL[position]}-${run}${EMAIL_DOMAIN}`,
      name: `Page check ${LABEL[position]}`,
      passwordHash: await hashPassword(password),
      mustChangePassword: false,
      ...positionToFields(position),
    },
    select: { email: true },
  });
}

/** Row count of every table, to show afterwards that nothing was left behind. */
async function tableCounts(): Promise<Map<string, number>> {
  const tables = await prisma.$queryRaw<{ name: string }[]>`
    select table_name as name from information_schema.tables
    where table_schema = current_schema() and table_type = 'BASE TABLE' and table_name <> '_prisma_migrations'`;
  const out = new Map<string, number>();
  for (const { name } of tables) {
    const [{ n }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`select count(*) as n from "${name.replace(/"/g, '""')}"`);
    out.set(name, Number(n));
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Server                                                                     */
/* -------------------------------------------------------------------------- */

let server: ChildProcess | null = null;

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/login`, { redirect: "manual" });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function startServer() {
  if (await reachable()) {
    throw new Error(`Something is already answering on port ${PORT}. Stop it, or pass --base to walk it.`);
  }
  // NODE_OPTIONS carries --conditions=react-server for this script; the server must not inherit it.
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: "", PORT: String(PORT) };
  // From the repository, wherever the command was typed.
  const root = fileURLToPath(new URL("..", import.meta.url));
  const next = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
  server = spawn(process.execPath, [next, "dev", "-p", String(PORT)], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  server.stdout?.on("data", (d) => (log = (log + d).slice(-4000)));
  server.stderr?.on("data", (d) => (log = (log + d).slice(-4000)));

  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    if (server.exitCode !== null) throw new Error(`The development server stopped:\n${log}`);
    if (await reachable()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`The development server did not answer within 3 minutes:\n${log}`);
}

function stopServer() {
  if (!server || server.exitCode !== null || server.pid === undefined) return;
  if (process.platform === "win32") {
    // next dev starts its own children; only killing the tree stops them.
    try {
      execFileSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  } else {
    server.kill("SIGTERM");
  }
  server = null;
}

/* -------------------------------------------------------------------------- */
/* The walk                                                                   */
/* -------------------------------------------------------------------------- */

/** Console errors and uncaught errors seen since the last call. */
function watchErrors(page: Page): () => string[] {
  let seen: string[] = [];
  page.on("console", (msg) => {
    const text = msg.text().split("\n")[0].slice(0, 160).trim();
    // React logs a bare "%o" beside the real error, which arrives as its own line.
    if (msg.type() === "error" && text !== "%o") seen.push(`console: ${text}`);
  });
  page.on("pageerror", (err) => seen.push(`uncaught: ${err.message.split("\n")[0].slice(0, 160)}`));
  return () => {
    const out = seen;
    seen = [];
    return out;
  };
}

async function settle(page: Page) {
  // Development servers keep a socket open for hot reload, so "network idle" is
  // a best effort, not a requirement.
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
}

/**
 * Null when the page fits; otherwise the innermost element that sticks out
 * past the right edge, so the failure says where to look.
 */
async function scrollsSideways(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const root = document.documentElement;
    if (root.scrollWidth <= root.clientWidth + 1) return null;
    let culprit: Element | null = null;
    for (const el of document.body.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      // Something inside a box that scrolls on its own is not the page's problem.
      if (r.width === 0 || r.right <= root.clientWidth + 1) continue;
      let clipped = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        if (o !== "visible") { clipped = true; break; }
      }
      if (!clipped) culprit = el;
    }
    if (!culprit) return `${root.scrollWidth}px wide`;
    const cls = typeof culprit.className === "string" ? culprit.className.trim().split(/\s+/).slice(0, 4).join(".") : "";
    const text = (culprit.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    return `${root.scrollWidth}px wide, past the edge: <${culprit.tagName.toLowerCase()}${cls ? `.${cls}` : ""}> "${text}"`;
  });
}

async function errorScreen(page: Page): Promise<string | null> {
  const headings = (await page.locator("h1, h2").allInnerTexts().catch(() => [] as string[])).map((h) => h.trim());
  return ERROR_SCREEN.find((e) => headings.some((h) => h.startsWith(e))) ?? null;
}

async function signIn(page: Page, email: string): Promise<string | null> {
  await page.goto(`${BASE}/login`, { timeout: PAGE_TIMEOUT });
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click("button[type=submit]");
  try {
    await page.waitForURL((u) => u.pathname !== "/login", { timeout: PAGE_TIMEOUT });
  } catch {
    const said = await page.locator("[role=alert]").innerText().catch(() => "");
    return `sign-in did not leave /login${said ? `: ${said}` : ""}`;
  }
  const path = new URL(page.url()).pathname;
  return path === "/dashboard" ? null : `sign-in landed on ${path}, not /dashboard`;
}

async function visit(page: Page, href: string, takeErrors: () => string[]): Promise<string[]> {
  const problems: string[] = [];
  takeErrors();
  await page.setViewportSize({ width: 1366, height: 900 });
  let status = 0;
  try {
    const res = await page.goto(`${BASE}${href}`, { timeout: PAGE_TIMEOUT });
    status = res?.status() ?? 0;
  } catch (e) {
    return [`did not load: ${(e as Error).message.split("\n")[0]}`];
  }
  await settle(page);

  if (status >= 400) problems.push(`HTTP ${status}`);
  const landed = new URL(page.url()).pathname;
  // A page opened with a query (a date range) lands on its path alone.
  if (landed !== href.split("?")[0]) problems.push(`sent to ${landed}`);
  const screen = await errorScreen(page);
  if (screen) problems.push(`error screen: "${screen}"`);

  for (const width of WIDTHS) {
    if (width !== 1366) {
      // Loaded again at this width rather than only resized, so anything the
      // page decides once as it loads is decided as a phone would see it.
      await page.setViewportSize({ width, height: 812 });
      await page.reload({ timeout: PAGE_TIMEOUT });
      await settle(page);
    }
    const wide = await scrollsSideways(page);
    if (wide) problems.push(`scrolls sideways at ${width}px (${wide})`);
  }
  // A moment for anything that reports late, so it is charged to this page and not the next.
  await page.waitForTimeout(500);
  // Loaded twice, so the same error usually arrives twice.
  problems.push(...new Set(takeErrors()));
  return problems;
}

/**
 * A page this position must not reach. The guards send them to their own
 * dashboard; landing anywhere else (the sign-in page, an error) is a failure
 * too, or a session that quietly broke would make every one of these pass.
 */
async function refused(page: Page, href: string, takeErrors: () => string[]): Promise<string[]> {
  takeErrors();
  try {
    await page.goto(`${BASE}${href}`, { timeout: PAGE_TIMEOUT });
  } catch (e) {
    return [`did not load: ${(e as Error).message.split("\n")[0]}`];
  }
  await settle(page);
  const landed = new URL(page.url()).pathname;
  const problems: string[] = [];
  if (landed === href) problems.push("opened, but this position should not reach it");
  else if (landed !== "/dashboard") problems.push(`sent to ${landed}, not /dashboard`);
  const screen = await errorScreen(page);
  if (screen) problems.push(`error screen: "${screen}"`);
  problems.push(...takeErrors());
  return problems;
}

async function walk(browser: Browser, position: Position, email: string) {
  const who = LABEL[position];
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  const takeErrors = watchErrors(page);

  const signInProblem = await signIn(page, email);
  record(who, "/login", signInProblem ? [signInProblem] : []);
  if (signInProblem) {
    await context.close();
    return;
  }

  const pages = NAV[position].map((n) => n.href);
  if (position === "ADMIN") pages.push(...ADMIN_EXTRA);
  for (const href of pages) record(who, href, await visit(page, href, takeErrors));

  // The sales workbook carries the commission split: only the admin gets it,
  // even on Sales insights, which shipping managers can open.
  const admin = position === "ADMIN";
  const workbook: string[] = [];
  if (pages.includes("/insights")) {
    await page.goto(`${BASE}/insights`, { timeout: PAGE_TIMEOUT });
    const landed = new URL(page.url()).pathname;
    if (landed !== "/insights") workbook.push(`sent to ${landed}`);
    const links = await page.locator('a[href^="/api/sales/export"]').count();
    if (admin ? links === 0 : links > 0) workbook.push(`${links} Download link(s) on Sales insights`);
    // A range with no sales at all: the empty page, not an error.
    record(who, "/insights with no sales in the range", await visit(page, "/insights?from=2030-01-01&to=2030-01-31", takeErrors));
  }
  const status = (await page.request.get(`${BASE}/api/sales/export?date=2026-01-01`)).status();
  if (!admin && status !== 403) workbook.push(`the workbook answered ${status}, not 403`);
  record(who, "sales workbook download (admin only)", workbook);

  for (const href of forbidden(position)) record(who, `${href} (must refuse)`, await refused(page, href, takeErrors));

  await context.close();
}

async function signedOut(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${BASE}/dashboard`, { timeout: PAGE_TIMEOUT });
  const landed = new URL(page.url()).pathname;
  record("signed out", "/dashboard (must refuse)", landed === "/login" ? [] : [`landed on ${landed}, not /login`]);
  await context.close();
}

/* -------------------------------------------------------------------------- */

/**
 * Stops the server and removes this run's accounts — once. Ctrl-C, and the
 * walk failing because Ctrl-C also closed Chrome, both arrive here, so both
 * wait on the same promise rather than one exiting while the other deletes.
 */
let cleaning: Promise<void> | null = null;
function cleanUp(): Promise<void> {
  cleaning ??= (async () => {
    stopServer();
    await removeCheckAccounts({ run });
  })();
  return cleaning;
}
let interrupted = false;
process.on("SIGINT", () => {
  if (interrupted) return;
  interrupted = true;
  console.log("\nStopped. Removing the check's accounts…");
  cleanUp()
    .catch((e) => console.error(`Could not remove the check's accounts: ${(e as Error).message}`))
    .finally(() => prisma.$disconnect().finally(() => process.exit(130)));
});

let failed = false;
let browser: Browser | null = null;
try {
  const leftover = await removeCheckAccounts({ onlyStale: true });
  if (leftover > 0) console.log(`Removed ${leftover} account(s) left by an earlier run.`);
  // What opening Inventory and the dashboards would do anyway — stock brought
  // up to date, the settings row made — done first, as nobody, so the walk
  // starts from a settled database and the counts below compare like with like.
  await getSettings();
  await bringStockUpToDate(null);
  const before = await tableCounts();

  if (OWN_SERVER) {
    console.log(`Starting a development server on ${BASE} (the first visit to each page compiles it)…`);
    await startServer();
  } else if (!(await reachable())) {
    throw new Error(`Nothing answers at ${BASE}.`);
  }

  const accounts = new Map<Position, string>();
  for (const p of POSITIONS) accounts.set(p, (await makeAccount(p)).email);

  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const p of POSITIONS) {
    console.log(`Walking as ${LABEL[p]}…`);
    await walk(browser, p, accounts.get(p)!);
  }
  await signedOut(browser);
  await browser.close();
  browser = null;

  stopServer();
  await cleanUp();

  // Payroll and the dashboards print hours for whoever was on a show that has
  // started, so those two tables may legitimately grow while the pages are
  // open. Any other change in a table's size — or those two shrinking — is
  // this check adding or removing something it should not have. (Counts, so
  // a row changed in place is not seen here.)
  const after = await tableCounts();
  const hours = (t: string) => t === "TimeEntry" || t === "TimeEntryRevision";
  const changed = [...after].filter(([t, n]) => n !== (before.get(t) ?? 0));
  const show = ([t, n]: [string, number]) => `${t} ${before.get(t) ?? 0} → ${n}`;
  const printed = changed.filter(([t, n]) => hours(t) && n > (before.get(t) ?? 0));
  const wrong = changed.filter((c) => !printed.includes(c));
  if (printed.length > 0) console.log(`note  scheduled hours printed while the pages were open: ${printed.map(show).join(", ")}`);
  record("cleanup", "accounts removed, no rows added or removed", wrong.map((c) => `row count changed: ${show(c)}`));
} catch (e) {
  failed = true;
  console.error(`\nThe check could not finish: ${(e as Error).message}`);
} finally {
  await browser?.close().catch(() => {});
  await cleanUp().catch((e) => {
    failed = true;
    console.error(`Could not remove the check's accounts: ${(e as Error).message}`);
  });
  await prisma.$disconnect();
}

/* -------------------------------------------------------------------------- */

const whoWidth = Math.max(...rows.map((r) => r.who.length), 3);
const pageWidth = Math.max(...rows.map((r) => r.page.length), 4);
console.log("");
for (const r of rows) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.who.padEnd(whoWidth)}  ${r.page.padEnd(pageWidth)}  ${r.detail}`.trimEnd());
}
const bad = rows.filter((r) => !r.ok).length;
console.log(`\n${rows.length - bad} passed, ${bad} failed.`);
if (bad > 0 || failed) process.exit(1);
