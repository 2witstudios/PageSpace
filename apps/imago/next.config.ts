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
// token then behave as in production. The proxy exists only in the dev
// server phase, so `next build` never bakes it into the routes manifest.
//
// Next renders any request carrying next-router-prefetch: 1 in prefetch mode,
// and for a document (non-RSC) request that render throws on the server
// (`location is not defined`, a 500). Middleware and headers() never see the
// flight headers, so such a request is rewritten to a 404 route instead.
// Rewrites run after middleware, so the gates still apply. The router's own
// prefetches send RSC: 1. API route handlers render no page, so the API space
// is rewritten only as a fallback: where no handler matches, Next would render
// the not-found page. Built fresh per route: Next rewrites the objects it loads.
const prefetchDocument = () => ({
  has: [{ type: "header" as const, key: "next-router-prefetch", value: "1" }],
  missing: [{ type: "header" as const, key: "rsc", value: "1" }],
  destination: "/api/prefetch-document",
});

export default function nextConfig(phase: string): NextConfig {
  return {
    basePath: "/imago",
    output: "standalone",
    outputFileTracingRoot: path.join(__dirname, "../.."),
    // getViewer() validates sessions with @pagespace/lib's session-service;
    // a task's description is edited on @pagespace/editor's document schema.
    // Compiled from source so the build never depends on a prebuilt dist/.
    transpilePackages: ["@pagespace/db", "@pagespace/lib", "@pagespace/editor"],
    serverExternalPackages: ["pg"],
    webpack: (config, { isServer, nextRuntime }) => {
      // @pagespace/editor is compiled from source through the tsconfig paths,
      // and its ESM source imports siblings as `./x.js`: those must resolve to
      // the `.ts` file, as apps/web resolves them. `.js` stays first so a real
      // `.js` under node_modules resolves on the first try.
      config.resolve.extensionAlias = {
        ...(config.resolve.extensionAlias ?? {}),
        ".js": [".js", ".ts", ".tsx"],
      };
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
    rewrites: async () => ({
      beforeFiles: [
        { source: "/", ...prefetchDocument() },
        { source: "/:path((?!api(?:/|$)|_next/).*)", ...prefetchDocument() },
      ],
      afterFiles:
        phase === PHASE_DEVELOPMENT_SERVER
          ? [
              {
                source: "/api/:path*",
                destination: `${webAppInternalOrigin()}/api/:path*`,
                basePath: false,
              },
            ]
          : [],
      fallback: [{ source: "/api/:path*", ...prefetchDocument() }],
    }),
  };
}
