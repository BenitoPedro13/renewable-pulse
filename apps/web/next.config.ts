import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output is for the Railway Docker image (docs/tasks/
  // TASK-railway-deploy.md §2.3) — only the traced server bundle ships
  // there, not the full node_modules tree. It must NOT be set when
  // building on Vercel: Vercel's own builder produces its own deployment
  // package and errors on missing standalone-specific trace files
  // otherwise (confirmed live: ENOENT on next-server.js.nft.json). Vercel
  // sets VERCEL=1 in its build environment, which is what distinguishes
  // the two targets here.
  output: process.env.VERCEL ? undefined : "standalone",
};

export default nextConfig;
