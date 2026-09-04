import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/auth/guards";
import { ChangePasswordForm } from "./form";

export const metadata: Metadata = { title: "Change password" };

export default async function ChangePasswordPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold tracking-tight text-ink">
            {user.mustChangePassword ? "Set your password" : "Change your password"}
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            {user.mustChangePassword
              ? "You are signed in with a temporary password. Choose your own to continue."
              : "Pick something you do not use anywhere else."}
          </p>
        </div>

        <div className="rounded-[var(--radius-card)] border border-line bg-surface p-5 shadow-[0_1px_2px_rgba(16,19,26,0.04)]">
          <ChangePasswordForm />
        </div>
      </div>
    </main>
  );
}
