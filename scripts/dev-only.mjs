/**
 * Refuses to run against anything but a local database.
 *
 * The `check-*` scripts write. They create fixture accounts, upload a day's
 * reports, close boxes, print hours, and delete what they made. Every one of
 * them reads `DATABASE_URL` — so a shell that still has production in its
 * environment, or a `.env` edited to look at Neon for five minutes, is one
 * command away from a script deleting a real day's shipping history.
 *
 * Nothing about the scripts themselves prevents that, and the moment somebody
 * is debugging production is exactly when they would run one. So the check is
 * here, at the top of each of them, rather than in a paragraph of the handover
 * that nobody reads twice.
 *
 * Local means a loopback host. Neon, Supabase, RDS and anything else with a
 * real hostname is refused.
 */
export function assertDevDatabase(scriptName = "This script") {
  const url = process.env.DATABASE_URL ?? "";

  if (!url) {
    console.error(`${scriptName} needs DATABASE_URL. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }

  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    console.error(`${scriptName} could not read DATABASE_URL as a connection string.`);
    process.exit(1);
  }

  const local =
    host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";

  if (!local) {
    console.error(
      `\nREFUSED. ${scriptName} writes to the database, and DATABASE_URL points at "${host}".\n\n` +
        `  These scripts create and delete fixture data. Against production that means\n` +
        `  deleting real uploads, boxes and scan history.\n\n` +
        `  Point DATABASE_URL at your local PostgreSQL and run it again.\n`,
    );
    process.exit(1);
  }
}
