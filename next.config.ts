import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Azure Container Apps runs the built app from a minimal Docker image
  // (see Dockerfile's `web` stage) copying only .next/standalone,
  // .next/static, and public/ — standalone output bundles a self-contained
  // server.js plus the production node_modules subset the app actually
  // needs, so the image does not require a full `npm install` at runtime.
  output: "standalone",
  serverExternalPackages: ["postgres"],
  // Dev-only: allow the local harness (and manual `next dev`) to load
  // `/_next` dev assets over loopback. Next `dev` blocks cross-origin dev
  // resources by default; this list is limited to loopback hosts and is
  // ignored by the production build/runtime. See ADR 0011.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
