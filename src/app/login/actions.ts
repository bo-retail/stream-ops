"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

export interface LoginState {
  error?: string;
}

const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1, "Enter your email.").max(200),
  password: z.string().min(1, "Enter your password."),
  next: z.string().optional(),
});

/**
 * Coarse in-process throttle.
 *
 * On a single Vercel instance this slows credential stuffing considerably; it is
 * not a substitute for a shared rate limiter if this ever runs at scale, but for
 * a team of ~30 it is proportionate.
 */
const attempts = new Map<string, { count: number; firstAt: number }>();
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 10;

function tooManyAttempts(key: string): boolean {
  const now = Date.now();
  const record = attempts.get(key);
  if (!record || now - record.firstAt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAt: now });
    return false;
  }
  record.count += 1;
  return record.count > MAX_ATTEMPTS;
}

function clearAttempts(key: string): void {
  attempts.delete(key);
}

/** Only allow redirects back into this app, never to an attacker-supplied host. */
function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/dashboard";
  return next;
}

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = LoginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    next: formData.get("next") ?? undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Enter your email and password." };
  }

  const { email, password, next } = parsed.data;

  if (tooManyAttempts(email)) {
    return { error: "Too many sign-in attempts. Wait a few minutes and try again." };
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, role: true, passwordHash: true, isActive: true },
  });

  // Always run a comparison, even for an unknown address, so response time does
  // not reveal which emails have accounts.
  const hash = user?.passwordHash ?? "$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin";
  const ok = await verifyPassword(password, hash);

  if (!user || !ok) {
    return { error: "Email or password is incorrect." };
  }
  if (!user.isActive) {
    return { error: "This account has been deactivated. Ask your admin to re-enable it." };
  }

  clearAttempts(email);
  await createSession({ id: user.id, email: user.email, name: user.name, role: user.role });

  redirect(safeNext(next));
}
