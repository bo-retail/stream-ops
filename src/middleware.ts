import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";
import { decideRoute } from "@/lib/auth/route-guard";

/**
 * First line of defence only.
 *
 * Middleware runs on the edge without database access, so it can check that a
 * token is validly signed and what role it claims, but it cannot know whether
 * the account is still active. Every page and action re-checks with
 * `requireUser` / `requireBoss` against the database — this exists to keep
 * signed-out visitors off application routes and to avoid rendering an admin
 * page shell to someone who will only be redirected away from it.
 *
 * The decision itself lives in `lib/auth/route-guard` so it can be tested
 * without constructing edge requests. See the note there about why a validly
 * signed token is not enough on its own.
 */
export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySessionToken(token) : null;

  const decision = decideRoute({
    pathname,
    search,
    hasCookie: token !== undefined,
    hasValidSession: session !== null,
    role: session?.role ?? null,
  });

  if (decision.kind === "allow") return NextResponse.next();

  if (decision.kind === "allowAndClear") {
    const response = NextResponse.next();
    response.cookies.delete(SESSION_COOKIE);
    return response;
  }

  const response = NextResponse.redirect(new URL(decision.to, request.url));
  if (decision.clear) response.cookies.delete(SESSION_COOKIE);
  return response;
}

export const config = {
  matcher: [
    // Everything except Next internals, the auth endpoints and static assets.
    "/((?!_next/static|_next/image|favicon.ico|api/auth|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
