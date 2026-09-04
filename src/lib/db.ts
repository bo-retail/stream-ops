import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

function createClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
  }

  /*
    Pool tuning matters here.

    Both the local `prisma dev` proxy and Neon's pooled endpoint hang up on
    connections that have been sitting idle, and a pool that hands out a socket
    the server has already closed surfaces as a random "Server has closed the
    connection" on whichever page happens to ask next. Recycling idle
    connections faster than the server drops them avoids that entirely.

    The small ceiling is deliberate too: serverless spins up many instances, and
    a large pool per instance is how a team of thirty exhausts a database's
    connection limit.
  */
  const adapter = new PrismaPg({
    connectionString,
    max: 5,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 15_000,
    keepAlive: true,
  });

  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

// Next.js hot-reloads modules in development; without caching on globalThis each
// reload would open a new pool and exhaust the database's connection limit.
const globalForPrisma = globalThis as unknown as { prisma?: ReturnType<typeof createClient> };

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
