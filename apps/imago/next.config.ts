import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import path from "path";

// pg resolves through bun's cache path (~/.bun/install/cache/pg@.../), which
// has no "node_modules" segment, so Next's heuristic misses it; externalize it
// by name for the Node.js server build, as apps/web and apps/admin do.
const PG_PACKAGES = new Set(["pg", "pg-pool", "pg-protocol", "pg-native"]);

// apps/web's own dev origin, used when WEB_APP_INTERNAL_URL is unset.
const DEFAULT_WEB_APP_INTERNAL_URL = "http://localhost:3000";

const webAppInternalOrigin = (): string => {
  const value = process.env.WEB_APP_INTERNAL_URL || DEFAULT_WEB_APP_INTERNAL_URL;
  try {
    return new URL(value).origin;
  } catch {
    throw new Error(`WEB_APP_INTERNAL_URL is not a valid URL: "${value}"`);
  }
};

// Served same-origin under pagespace.ai/imago, beside classic apps/web.
// Dev runs on :3006 (package.json `dev`); production ships the standalone
// server, traced from the monorepo root so workspace packages are included.
//
// In production the edge routes /imago to this app and /api to apps/web, so
// the browser already sees one origin. `next dev` has no edge, so it proxies
// /api (outside basePath) to apps/web itself: the session cookie and CSRF
// token then behave as in production. The rewrite exists only in the dev
// server phase, so `next build` never bakes it into the routes manifest.
export default function nextConfig(phase: string): NextConfig {
  return {
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
    ...(phase === PHASE_DEVELOPMENT_SERVER && {
      rewrites: async () => [
        {
          source: "/api/:path*",
          destination: `${webAppInternalOrigin()}/api/:path*`,
          basePath: false,
        },
      ],
    }),
  };
}
