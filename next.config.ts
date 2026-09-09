import type { NextConfig } from "next";

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
};

export default nextConfig;
