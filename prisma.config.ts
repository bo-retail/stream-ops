import "dotenv/config";
import { defineConfig } from "prisma/config";

/**
 * The connection the Prisma CLI uses for migrations.
 *
 * `DATABASE_URL` is Neon's *pooled* endpoint, which is right for the app — many
 * short-lived serverless connections — but wrong for migrations. The pooler
 * (PgBouncer in transaction mode) does not support the session-level locks and
 * DDL that `migrate deploy` needs, and the symptom is an intermittent P1002
 * timeout rather than a clear error, so it can appear to work for a long time
 * before failing during a deploy.
 *
 * Neon's direct endpoint is the same host without the `-pooler` suffix, so this
 * is derived rather than requiring a second secret to be kept in sync. Set
 * `DIRECT_URL` explicitly to override it.
 */
function migrationUrl(): string | undefined {
  const explicit = process.env["DIRECT_URL"];
  if (explicit) return explicit;

  const pooled = process.env["DATABASE_URL"];
  return pooled?.replace("-pooler.", ".");
}

/**
 * Only `migrate dev` uses a shadow database, and it must be a *different*
 * database — Prisma refuses to start if it is the same one, which would
 * otherwise break `migrate deploy` for a setting it never uses. This project's
 * workflow is `migrate diff` plus `migrate deploy`, so the shadow database is
 * usually absent; passing it through only when it is genuinely separate keeps
 * `migrate dev` available to anyone who does configure one.
 */
function shadowUrl(): string | undefined {
  const shadow = process.env["SHADOW_DATABASE_URL"];
  if (!shadow) return undefined;
  return shadow === migrationUrl() || shadow === process.env["DATABASE_URL"] ? undefined : shadow;
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: migrationUrl(),
    shadowDatabaseUrl: shadowUrl(),
  },
});
