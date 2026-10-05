import type { NextConfig } from "next";
import { IMAGE_HOSTS } from "./src/lib/domain/watch-images";

/**
 * Headers every response carries.
 *
 * This app has destructive admin actions behind a session cookie — deleting a
 * release, removing a day's report, correcting somebody's pay — and a cookie is
 * sent whether the click came from the real page or from a page framing it. The
 * cookie is already `sameSite: lax`, which covers most of it; these close the
 * rest and cost nothing.
 *
 * `frame-ancestors 'none'` rather than only `X-Frame-Options`, because the
 * former is the one modern browsers actually enforce. It does not affect
 * hosting this under an existing domain: the documented way to do that is a
 * Vercel rewrite, which is server-side and never puts the app in a frame.
 */
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Nothing here uses a camera, a microphone or a location.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  // Two years, and only meaningful over HTTPS — browsers ignore it otherwise,
  // so it is harmless on http://localhost.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  experimental: {
    /**
     * The morning's three exports go up through a server action, and the
     * default body limit is 1 MB. A real day is about 350 KB, which would work
     * until the first busy week quietly pushed it over and the upload started
     * failing with nothing useful on screen.
     */
    serverActions: { bodySizeLimit: "16mb" },
  },
  /**
   * The watch pictures come from Invicta's servers at up to a few megabytes
   * each; the resizer turns them into small thumbnails and keeps them a month,
   * so each one is fetched and shrunk once rather than on every page.
   */
  images: {
    remotePatterns: IMAGE_HOSTS.flatMap((host) => [
      { protocol: "https" as const, hostname: host },
      { protocol: "https" as const, hostname: `**.${host}` },
    ]),
    minimumCacheTTL: 60 * 60 * 24 * 31,
    // Few sizes, so the stock list (48 px) and the count screen (64 px) share
    // the same shrunk copies: 64 and 128 for both, 256 and 640 for the model page.
    imageSizes: [64, 128, 256],
  },
  /**
   * The eBay and TikTok upload templates the day's plan fills in are read from
   * disk when a file is downloaded, so they have to ship with that route.
   */
  outputFileTracingIncludes: {
    "/api/inventory/plan/[date]/[file]": ["./src/lib/server/listing-templates/*.xlsx"],
  },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
