import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Azure Container Apps runs the built app from a minimal Docker image
  // (see Dockerfile's `web` stage) copying only .next/standalone,
  // .next/static, and public/ — standalone output bundles a self-contained
  // server.js plus the production node_modules subset the app actually
  // needs, so the image does not require a full `npm install` at runtime.
  output: "standalone",
  serverExternalPackages: ["postgres"],
};

export default nextConfig;
