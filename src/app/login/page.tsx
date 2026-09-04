import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-brand-600 text-lg font-bold text-white">
            S
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">StreamOps</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Show scheduling for the live-selling team.
          </p>
        </div>

        <div className="rounded-[var(--radius-card)] border border-line bg-surface p-5 shadow-[0_1px_2px_rgba(16,19,26,0.04)]">
          <LoginForm next={next} />
        </div>

        <p className="mt-4 text-center text-xs text-ink-subtle">
          Trouble signing in? Ask your admin to reset your password.
        </p>
      </div>
    </main>
  );
}
