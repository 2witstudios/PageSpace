import type { NextConfig } from "next";
import path from "path";

// Served same-origin under pagespace.ai/imago, beside classic apps/web.
// Dev runs on :3006 (package.json `dev`); production ships the standalone
// server, traced from the monorepo root so workspace packages are included.
const nextConfig: NextConfig = {
  basePath: "/imago",
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../.."),
};

export default nextConfig;
