import type { NextConfig } from "next";

// Mock-UI phase: no workspace packages, no Sentry, no custom webpack. The
// backend phase adds @pagespace/db|lib and inherits admin's externals pattern.
const nextConfig: NextConfig = {
  output: "standalone",
};

export default nextConfig;
