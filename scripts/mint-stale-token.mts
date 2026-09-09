/**
 * Mints a session token for an account that does not exist.
 *
 * Reproduces the state that caused ERR_TOO_MANY_REDIRECTS: a cookie whose
 * signature is perfectly valid, naming somebody the database will refuse.
 * That is what a deactivated or deleted user is left holding.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/mint-stale-token.mts
 *
 * Prints the token. Development only — it proves nothing about a real account
 * and grants nothing, because every page re-reads the user from the database.
 */
import "dotenv/config";
import { SignJWT } from "jose";

const secret = process.env.AUTH_SECRET;
if (!secret || secret.length < 32) {
  console.error("AUTH_SECRET is missing or too short.");
  process.exit(1);
}

const token = await new SignJWT({
  email: "ghost@example.test",
  name: "Ghost Account",
  role: "EMPLOYEE",
})
  .setProtectedHeader({ alg: "HS256" })
  .setSubject("this-user-id-does-not-exist")
  .setIssuedAt()
  .setExpirationTime(new Date(Date.now() + 7 * 86_400_000))
  .sign(new TextEncoder().encode(secret));

console.log(token);
