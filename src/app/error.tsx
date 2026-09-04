"use client";

import { useEffect } from "react";

/**
 * Whole-app error screen.
 *
 * The default Next.js error page shows a stack trace, which tells a non-technical
 * user nothing about what to do. The overwhelmingly common failure in this setup
 * is simply that the database is not running, so that case is detected and
 * answered in plain language with the exact command to fix it.
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

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-lg">
        <div className="rounded-[var(--radius-card)] border border-line bg-surface p-6 shadow-[0_1px_2px_rgba(16,19,26,0.04)]">
          {databaseDown ? (
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
                  Open the PowerShell window running the database and check it is still going. If it
                  closed or shows errors, start it again:
                </p>
                <pre className="tabular mt-2 overflow-x-auto rounded-md bg-surface px-3 py-2 text-xs text-ink ring-1 ring-inset ring-line">
{`cd "C:\\Users\\samue\\Downloads\\STREAM\\stream-ops"
npx.cmd prisma dev --name streamops`}
                </pre>
                <p className="mt-2 text-xs text-ink-muted">
                  Wait for <strong>&ldquo;server streamops is now running&rdquo;</strong>, then press
                  the button below.
                </p>
              </div>

              <p className="mt-3 text-xs text-ink-muted">
                If it refuses to start with <code>Aborted()</code> errors, see &ldquo;If the database
                refuses to start&rdquo; in QUICKSTART.md — there are three lines to clear the stale
                lock files.
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
