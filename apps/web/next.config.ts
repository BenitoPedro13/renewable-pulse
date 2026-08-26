import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output for the Railway Docker image — only the traced
  // server bundle ships, not the full node_modules tree (docs/tasks/
  // TASK-railway-deploy.md §2.3).
  output: "standalone",
};

export default nextConfig;
