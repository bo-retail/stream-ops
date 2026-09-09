import { describe, expect, it } from "vitest";
import { STALE_SESSION_PATH, decideRoute } from "./route-guard";
import type { RouteRequest } from "./route-guard";

function request(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    pathname: "/dashboard",
    search: "",
    hasCookie: false,
    hasValidSession: false,
    role: null,
    ...overrides,
  };
}

/** A signed-in streamer. */
const signedIn = { hasCookie: true, hasValidSession: true, role: "EMPLOYEE" };

describe("a signed-out visitor", () => {
  it("is sent to the login page", () => {
    expect(decideRoute(request({ pathname: "/dashboard" }))).toEqual({
      kind: "redirect",
      to: "/login?next=%2Fdashboard",
      clear: false,
    });
  });

  it("keeps where they were going, query string and all", () => {
    const decision = decideRoute(request({ pathname: "/schedule", search: "?period=2026-09" }));
    expect(decision).toMatchObject({ to: "/login?next=%2Fschedule%3Fperiod%3D2026-09" });
  });

  it("is not sent round in a circle from the root", () => {
    expect(decideRoute(request({ pathname: "/" }))).toMatchObject({ to: "/login" });
  });

  it("sees the login page without interference", () => {
    expect(decideRoute(request({ pathname: "/login" }))).toEqual({ kind: "allow" });
  });

  it("has an unusable cookie taken away rather than resent on every request", () => {
    // Expired, tampered with, or signed by a rotated secret.
    expect(decideRoute(request({ pathname: "/login", hasCookie: true }))).toEqual({
      kind: "allowAndClear",
    });
    expect(decideRoute(request({ pathname: "/dashboard", hasCookie: true }))).toMatchObject({
      clear: true,
    });
  });
});

describe("a signed-in employee", () => {
  it("reaches an ordinary page", () => {
    expect(decideRoute(request({ ...signedIn, pathname: "/schedule" }))).toEqual({ kind: "allow" });
  });

  it("is taken off the login page", () => {
    expect(decideRoute(request({ ...signedIn, pathname: "/login" }))).toEqual({
      kind: "redirect",
      to: "/dashboard",
      clear: false,
    });
  });

  it("cannot reach an admin page", () => {
    expect(decideRoute(request({ ...signedIn, pathname: "/admin/team" }))).toMatchObject({
      to: "/dashboard",
    });
  });

  it("cannot reach one as the shipping director either", () => {
    // MANAGER is not BOSS, so the edge turns it away before the page renders.
    expect(
      decideRoute(request({ ...signedIn, role: "MANAGER", pathname: "/admin/timesheets" })),
    ).toMatchObject({ to: "/dashboard" });
  });

  it("reaches an admin page as the boss", () => {
    expect(decideRoute(request({ ...signedIn, role: "BOSS", pathname: "/admin/team" }))).toEqual({
      kind: "allow",
    });
  });
});

describe("a token the database refuses", () => {
  // Deactivating somebody, or deleting them, leaves a cookie that is still
  // validly signed. Middleware cannot see the database and so still believes it.

  it("does not trap them in a redirect loop", () => {
    // Before the fix: the guard sent them to /login, the edge saw a valid
    // session and sent them to /dashboard, the guard read the database and sent
    // them to /login... and the browser gave up with ERR_TOO_MANY_REDIRECTS,
    // unable to reach even the page that would let them sign in again.
    const decision = decideRoute(
      request({ ...signedIn, pathname: "/login", search: "?session=stale" }),
    );
    expect(decision).toEqual({ kind: "allowAndClear" });
  });

  it("uses the path the guards actually redirect to", () => {
    const [pathname, search] = STALE_SESSION_PATH.split("?");
    expect(decideRoute(request({ ...signedIn, pathname, search: `?${search}` }))).toEqual({
      kind: "allowAndClear",
    });
  });

  it("still bounces them off the login page without the marker", () => {
    // So a signed-in person visiting /login normally still lands on their
    // dashboard rather than being signed out.
    expect(decideRoute(request({ ...signedIn, pathname: "/login" }))).toMatchObject({
      to: "/dashboard",
    });
  });

  it("only ever signs out whoever forges the marker", () => {
    // The marker is guessable, and that is harmless: the worst it can do is
    // clear your own cookie.
    expect(
      decideRoute(request({ ...signedIn, role: "BOSS", pathname: "/login", search: "?session=stale" })),
    ).toEqual({ kind: "allowAndClear" });
  });

  it("ignores the marker anywhere other than the login page", () => {
    expect(
      decideRoute(request({ ...signedIn, pathname: "/dashboard", search: "?session=stale" })),
    ).toEqual({ kind: "allow" });
  });
});
