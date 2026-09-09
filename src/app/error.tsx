"use client";

import { useEffect } from "react";

/**
 * Whole-app error screen.
 *
 * The default Next.js error page shows a stack trace, which tells a
 * non-technical user nothing about what to do. The common failure is that the
 * database cannot be reached, so that case is detected and answered in plain
 * language.
 *
 * What that answer is depends entirely on where the app is running, and the two
 * cases have nothing in common:
 *
 *   - **Locally**, the database is a program on the same machine that someone
 *     has to start. Telling them how is the whole point of this screen.
 *   - **In production**, it is Neon, and nobody reading this can do anything
 *     about it. `Server has closed the connection` is the documented symptom of
 *     Neon's pooler dropping an idle socket (see `src/lib/db.ts`), which
 *     resolves itself on the next request — so a streamer looking at their
 *     shifts on a phone gets "try again", not a terminal command.
 *
 * This page used to print a local command with an absolute path from the
 * machine it was written on, in production, to everybody.
 */

function isDatabaseDown(message: string): boolean {
  const signals = [
    "does not exist in the current database",
    "Can't reach database server",
    "Server has closed the connection",
    "Connection terminated",
    "ECONNREFUSED",
    "P1001",
    "P1017",
    "P2021",
  ];
  return signals.some((s) => message.includes(s));
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const databaseDown = isDatabaseDown(error.message ?? "");
  const local = process.env.NODE_ENV === "development";

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-lg">
        <div className="rounded-[var(--radius-card)] border border-line bg-surface p-6 shadow-[0_1px_2px_rgba(16,19,26,0.04)]">
          {databaseDown && local ? (
            <>
              <h1 className="text-lg font-semibold text-ink">The database isn&apos;t running</h1>
              <p className="mt-2 text-sm text-ink-muted">
                The website is fine — it just has nothing to talk to. Your data is safe; it lives
                on disk, separate from the running programs.
              </p>

              <div className="mt-4 rounded-lg border border-line bg-canvas p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
                  To fix it
                </p>
                <p className="mt-1.5 text-sm text-ink">
                  PostgreSQL runs as a Windows service. Start it again from an admin PowerShell:
                </p>
                <pre className="tabular mt-2 overflow-x-auto rounded-md bg-surface px-3 py-2 text-xs text-ink ring-1 ring-inset ring-line">
{`Start-Service postgresql-x64-17`}
                </pre>
                <p className="mt-2 text-xs text-ink-muted">
                  Then press the button below. If that service does not exist, check what{" "}
                  <code>DATABASE_URL</code> in <code>.env</code> points at. This message only
                  appears in local development.
                </p>
              </div>
            </>
          ) : databaseDown ? (
            <>
              <h1 className="text-lg font-semibold text-ink">Can&apos;t reach the database</h1>
              <p className="mt-2 text-sm text-ink-muted">
                Nothing has been lost and nothing you did caused this. The connection dropped for a
                moment, which usually fixes itself straight away.
              </p>
              <p className="mt-2 text-sm text-ink-muted">
                Wait a few seconds and try again. If it keeps happening, tell your admin.
              </p>
            </>
          ) : (
            <>
              <h1 className="text-lg font-semibold text-ink">Something went wrong</h1>
              <p className="mt-2 text-sm text-ink-muted">
                This page hit an error. Nothing you were looking at has been changed or lost.
              </p>
              <pre className="mt-3 max-h-40 overflow-auto rounded-md bg-canvas px-3 py-2 text-xs text-ink-muted ring-1 ring-inset ring-line">
                {error.message}
              </pre>
            </>
          )}

          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={reset}
              className="inline-flex h-10 items-center justify-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700"
            >
              Try again
            </button>
            <a
              href="/dashboard"
              className="inline-flex h-10 items-center justify-center rounded-lg border border-line-strong bg-surface px-4 text-sm font-medium text-ink hover:bg-canvas"
            >
              Back to dashboard
            </a>
          </div>
        </div>
      </div>
    </main>
  );
}
