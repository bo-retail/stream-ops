/**
 * Signs in the way a browser does — posting the real login form to the server
 * action — and checks a session cookie comes back and opens a protected page.
 *
 * This exercises the whole path (form -> action -> password check -> cookie ->
 * guard), rather than minting a token and assuming the login half works.
 */
const BASE = process.argv[2] ?? "http://localhost:3000";
const EMAIL = process.argv[3] ?? "boss@streamops.local";
const PASSWORD = process.argv[4] ?? "ChangeMe123!";

// The login page carries the server action's id; the form post needs it.
const page = await fetch(`${BASE}/login`);
const html = await page.text();
console.log(`login page: HTTP ${page.status}`);

const actionId = html.match(/"([0-9a-f]{40,})"/)?.[1];
if (!actionId) {
  console.log("could not find the form action id in the page");
  process.exit(1);
}

const body = new FormData();
body.set("email", EMAIL);
body.set("password", PASSWORD);

const res = await fetch(`${BASE}/login`, {
  method: "POST",
  headers: { "next-action": actionId },
  body,
  redirect: "manual",
});

const text = await res.text();
const setCookie = res.headers.getSetCookie?.() ?? [];
const session = setCookie.find((c) => c.startsWith("streamops_session="));

console.log(`login POST: HTTP ${res.status}`);
console.log(`session cookie issued: ${session ? "YES" : "NO"}`);

if (text.includes("Email or password is incorrect")) {
  console.log('RESULT: rejected — "Email or password is incorrect"');
  process.exit(1);
}
if (text.includes("deactivated")) {
  console.log("RESULT: rejected — account deactivated");
  process.exit(1);
}
if (text.includes("Too many sign-in attempts")) {
  console.log("RESULT: rejected — rate limited (wait a few minutes)");
  process.exit(1);
}
if (!session) {
  console.log("RESULT: no session cookie — login did not succeed");
  process.exit(1);
}

// Now use that cookie on a protected page, as the browser would.
const cookie = session.split(";")[0];
const dash = await fetch(`${BASE}/dashboard`, { headers: { cookie }, redirect: "manual" });
const dashText = dash.status === 200 ? await dash.text() : "";

console.log(`dashboard with that cookie: HTTP ${dash.status}`);
console.log(
  dash.status === 200 && dashText.includes("Needs your attention")
    ? "\nRESULT: login works. Credentials and session are fine."
    : `\nRESULT: signed in but the dashboard did not load (status ${dash.status})`,
);
process.exit(dash.status === 200 ? 0 : 1);
