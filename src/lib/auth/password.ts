import bcrypt from "bcryptjs";

/** Cost factor. 12 keeps a login around ~200ms on Vercel's runtime. */
const ROUNDS = 12;

export const PASSWORD_MIN_LENGTH = 10;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * Password rules, deliberately length-first rather than a character-class maze —
 * the staff using this are non-technical and complexity rules mostly produce
 * `Password1!` written on a sticky note.
 */
export function validatePassword(plain: string): string | null {
  if (plain.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (plain.length > 200) return "Password is too long.";
  if (/^\s|\s$/.test(plain)) return "Password cannot start or end with a space.";
  const common = ["password", "12345678", "qwerty", "letmein", "streamops"];
  if (common.some((c) => plain.toLowerCase().includes(c))) {
    return "Password is too easy to guess. Pick something less common.";
  }
  return null;
}

/** Readable temporary password for a newly created employee account. */
export function generateTemporaryPassword(): string {
  const words = [
    "amber", "basalt", "cedar", "delta", "ember", "flint", "garnet", "harbor",
    "indigo", "jasper", "kelp", "lumen", "marble", "nimbus", "onyx", "pewter",
  ];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  const digits = String(Math.floor(Math.random() * 9000) + 1000);
  return `${pick()}-${pick()}-${digits}`;
}
