import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";

/**
 * First line of defence only.
 *
 * Middleware runs on the edge without database access, so it can check that a
 * token is validly signed and what role it claims, but it cannot know whether
 * the account is still active. Every page and action re-checks with
 * `requireUser` / `requireBoss` against the database — this exists to keep
 * signed-out visitors off application routes and to avoid rendering an admin
 * page shell to someone who will only be redirected away from it.
 */

const PUBLIC_PATHS = ["/login"];
const ADMIN_PREFIX = "/admin";

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySessionToken(token) : null;

  if (PUBLIC_PATHS.includes(pathname)) {
    if (session) return NextResponse.redirect(new URL("/dashboard", request.url));
    return NextResponse.next();
  }

  if (!session) {
    const loginUrl = new URL("/login", request.url);
    if (pathname !== "/") loginUrl.searchParams.set("next", `${pathname}${search}`);
    const response = NextResponse.redirect(loginUrl);
    // Clear an unusable cookie so the browser stops sending it on every request.
    if (token) response.cookies.delete(SESSION_COOKIE);
    return response;
  }

  if (pathname.startsWith(ADMIN_PREFIX) && session.role !== "BOSS") {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Everything except Next internals, the auth endpoints and static assets.
    "/((?!_next/static|_next/image|favicon.ico|api/auth|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
