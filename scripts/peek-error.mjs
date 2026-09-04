/** Fetches one page as the boss and digs the real error text out of the RSC payload. */
import "dotenv/config";
import { SignJWT } from "jose";
import { Client } from "pg";

const path = process.argv[2] ?? "/dashboard";
const BASE = process.argv[3] ?? "http://localhost:3000";

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const { rows } = await db.query(
  `select id, email, name, role from "User" where role = 'BOSS' and "isActive" limit 1`,
);
await db.end();

const boss = rows[0];
const token = await new SignJWT({ email: boss.email, name: boss.name, role: boss.role })
  .setProtectedHeader({ alg: "HS256" })
  .setSubject(boss.id)
  .setIssuedAt()
  .setExpirationTime(new Date(Date.now() + 3_600_000))
  .sign(new TextEncoder().encode(process.env.AUTH_SECRET));

const res = await fetch(`${BASE}${path}`, {
  headers: { cookie: `streamops_session=${token}` },
  redirect: "manual",
});
const body = await res.text();
console.log(`${res.status} ${path}\n`);

// Next embeds the server error in the flight payload; pull out anything that
// reads like a message or a stack frame rather than dumping 200KB of chunks.
const patterns = [
  /"message":"((?:[^"\\]|\\.)*)"/g,
  /"digest":"((?:[^"\\]|\\.)*)"/g,
  /Invalid[^"\\]{0,200}/g,
  /PrismaClient[^"\\]{0,200}/g,
  /Error: [^"\\]{0,200}/g,
  /Cannot read[^"\\]{0,160}/g,
  /is not a function[^"\\]{0,80}/g,
  /Unknown (?:field|argument|arg)[^"\\]{0,160}/g,
];

const seen = new Set();
for (const pattern of patterns) {
  for (const match of body.matchAll(pattern)) {
    const text = (match[1] ?? match[0]).replace(/\\n/g, "\n").replace(/\\"/g, '"').trim();
    if (text.length < 4 || seen.has(text)) continue;
    seen.add(text);
    console.log("→", text.slice(0, 600));
  }
}

if (seen.size === 0) console.log("(no error text found in the payload)");
