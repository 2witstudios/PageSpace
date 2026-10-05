import type { NextConfig } from "next";
import path from "path";

// pg resolves through bun's cache path (~/.bun/install/cache/pg@.../), which
// has no "node_modules" segment, so Next's heuristic misses it; externalize it
// by name for the Node.js server build, as apps/web and apps/admin do.
const PG_PACKAGES = new Set(["pg", "pg-pool", "pg-protocol", "pg-native"]);

// Served same-origin under pagespace.ai/imago, beside classic apps/web.
// Dev runs on :3006 (package.json `dev`); production ships the standalone
// server, traced from the monorepo root so workspace packages are included.
const nextConfig: NextConfig = {
  basePath: "/imago",
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../.."),
  // getViewer() validates sessions with @pagespace/lib's session-service.
  // Compiled from source so the build never depends on a prebuilt dist/.
  transpilePackages: ["@pagespace/db", "@pagespace/lib"],
  serverExternalPackages: ["pg"],
  webpack: (config, { isServer, nextRuntime }) => {
    // The edge (middleware) compile has no require(), so it is left alone:
    // middleware imports only the dependency-free sign-in-url module.
    if (isServer && nextRuntime === "nodejs") {
      const pgExternals = (
        { request }: { request?: string },
        callback: (err?: Error | null, result?: string) => void,
      ) => {
        if (request && PG_PACKAGES.has(request)) {
          return callback(null, `commonjs ${request}`);
        }
        callback();
      };
      config.externals = [
        ...(Array.isArray(config.externals)
          ? config.externals
          : config.externals
            ? [config.externals]
            : []),
        pgExternals,
      ];
    }
    return config;
  },
};

export default nextConfig;
