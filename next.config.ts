import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["postgres"],
  // Dev-only: allow the local harness (and manual `next dev`) to load
  // `/_next` dev assets over loopback. Next `dev` blocks cross-origin dev
  // resources by default; this list is limited to loopback hosts and is
  // ignored by the production build/runtime. See ADR 0011.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
