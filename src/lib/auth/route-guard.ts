/**
 * What the edge should do with a request, decided without touching anything.
 *
 * Middleware runs before the database is reachable, so all it can know is
 * whether the cookie carries a validly *signed* token and what role that token
 * claims. The authority is still `requireUser`, which re-reads the account on
 * every request.
 *
 * That split is what made a redirect loop possible. A token can be perfectly
 * signed and still name somebody the database will refuse — a deactivated
 * account, or one that has been deleted. Middleware saw a session and sent them
 * to the dashboard; the dashboard read the database, refused, and sent them
 * back to the login page; middleware saw a session again. Neither side was
 * wrong on its own, and between them the browser could not reach a single page,
 * including the one that would have let them sign in again.
 *
 * The way out is for the page that refuses to say so: it redirects to
 * `/login?session=stale`, and that marker is the one case where the edge lets
 * the login page render and drops the cookie on the way. Forging the marker
 * only signs yourself out.
 */

/** Set by a guard that has read the database and found the session unusable. */
export const STALE_SESSION_PARAM = "session";
export const STALE_SESSION_VALUE = "stale";

/** Where a guard sends somebody whose token is fine but whose account is not. */
export const STALE_SESSION_PATH = `/login?${STALE_SESSION_PARAM}=${STALE_SESSION_VALUE}`;

export const PUBLIC_PATHS = ["/login"];
export const ADMIN_PREFIX = "/admin";

export type RouteDecision =
  /** Carry on to the page. */
  | { kind: "allow" }
  /** Carry on, but drop the session cookie first. */
  | { kind: "allowAndClear" }
  /** Send them elsewhere. `clear` drops an unusable cookie on the way. */
  | { kind: "redirect"; to: string; clear: boolean };

export interface RouteRequest {
  pathname: string;
  /** The query string as it arrived, `?` included or not — both are accepted. */
  search: string;
  /** A cookie was sent, whether or not it verified. */
  hasCookie: boolean;
  /** The cookie carried a validly signed, unexpired token. */
  hasValidSession: boolean;
  /** What that token claims. Only meaningful when the session is valid. */
  role: string | null;
}

function isStaleMarker(search: string): boolean {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return params.get(STALE_SESSION_PARAM) === STALE_SESSION_VALUE;
}

export function decideRoute(request: RouteRequest): RouteDecision {
  const { pathname, search, hasCookie, hasValidSession, role } = request;

  if (PUBLIC_PATHS.includes(pathname)) {
    // A guard has already read the database and refused this session. Let the
    // login page render, and take the cookie away so the next request is clean.
    if (hasValidSession && isStaleMarker(search)) return { kind: "allowAndClear" };
    if (hasValidSession) return { kind: "redirect", to: "/dashboard", clear: false };
    // No usable session, but a cookie came anyway: expired, tampered with, or
    // signed by a rotated secret. Drop it so it stops being sent.
    return hasCookie ? { kind: "allowAndClear" } : { kind: "allow" };
  }

  if (!hasValidSession) {
    const next = pathname === "/" ? null : `${pathname}${search}`;
    const to = next ? `/login?next=${encodeURIComponent(next)}` : "/login";
    return { kind: "redirect", to, clear: hasCookie };
  }

  if (pathname.startsWith(ADMIN_PREFIX) && role !== "BOSS") {
    return { kind: "redirect", to: "/dashboard", clear: false };
  }

  return { kind: "allow" };
}
