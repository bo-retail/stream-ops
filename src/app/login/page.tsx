import type { Metadata } from "next";
import { DialMark } from "@/components/ui";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-dial px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <DialMark className="mx-auto mb-3 h-11 w-11 border-[3px]" />
          <h1 className="text-xl font-bold tracking-[0.01em] text-white">StreamOps</h1>
          <p className="mt-1 text-sm text-dial-ink">
            Show scheduling for the live-selling team.
          </p>
        </div>

        <div className="rounded-[var(--radius-card)] bg-surface p-5 shadow-card">
          <LoginForm next={next} />
        </div>

        <p className="mt-4 text-center text-xs text-dial-ink">
          Trouble signing in? Ask your admin to reset your password.
        </p>
      </div>
    </main>
  );
}
