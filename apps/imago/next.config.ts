import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import fs from "fs";
import path from "path";
import CopyPlugin from 'copy-webpack-plugin';

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

// The /api proxy target for a production build with no edge in front of it
// (Docker Compose publishes this server directly). Read at `next build`, which
// bakes rewrites into the routes manifest; the server never re-reads it.
// Unset behind Caddy, Fly and Traefik, which route /api to apps/web already.
const apiProxyOrigin = (): string | undefined => {
  const value = process.env.IMAGO_API_PROXY_ORIGIN;
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
  } catch {
    // reported below
  }
  throw new Error(`IMAGO_API_PROXY_ORIGIN is not an http(s) URL: "${value}"`);
};

// Served same-origin under pagespace.ai/imago, beside classic apps/web.
// Dev runs on :3006 (package.json `dev`); production ships the standalone
// server, traced from the monorepo root so workspace packages are included.
//
// In production the edge routes /imago to this app and /api to apps/web, so
// the browser already sees one origin. `next dev` has no edge, so it proxies
// /api (outside basePath) to apps/web itself: the session cookie and CSRF
// token then behave as in production. Outside `next dev` the proxy exists
// only when IMAGO_API_PROXY_ORIGIN is set, so the image the edge serves carries
// none (a second /api route behind Caddy would double-route).
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

// Monaco's AMD loader and pdf.js's worker are served as files, not bundled.
// webpack() copies them with CopyPlugin; Turbopack never runs webpack(), so a
// `next dev --turbopack` session copies them as the config loads instead.
const staticAssetCopies = (outputPath: string) => [
  { from: path.dirname(require.resolve('monaco-editor/min/vs/loader.js')), to: path.join(outputPath, 'static', 'monaco', 'vs') },
  { from: require.resolve('pdfjs-dist/build/pdf.worker.min.mjs'), to: path.join(__dirname, 'public', 'pdf.worker.min.mjs') },
];

// The config loads in every dev worker, so a copy newer than its source is kept.
function copyStaticAssets(outputPath: string): void {
  for (const { from, to } of staticAssetCopies(outputPath)) {
    if (fs.existsSync(to) && fs.statSync(to).mtimeMs >= fs.statSync(from).mtimeMs) continue;
    fs.cpSync(from, to, { recursive: true, force: true });
  }
}

const apiProxy = (origin: string) => ({
  source: "/api/:path*",
  destination: `${origin}/api/:path*`,
  basePath: false as const,
});

export default function nextConfig(phase: string): NextConfig {
  // Set by `next dev --turbopack` before this file is evaluated.
  if (process.env.TURBOPACK) {
    copyStaticAssets(path.join(__dirname, ".next"));
  }
  return {
    basePath: "/imago",
    output: "standalone",
    outputFileTracingRoot: path.join(__dirname, "../.."),
    // getViewer() validates sessions with @pagespace/lib's session-service;
    // a task's description is edited on @pagespace/editor's document schema.
    // Compiled from source so the build never depends on a prebuilt dist/.
    transpilePackages: ["@pagespace/db", "@pagespace/lib", "@pagespace/editor"],
    serverExternalPackages: ["pg"],
    // @pagespace/editor is compiled from source through the tsconfig paths;
    // its ESM source imports siblings as `./x.ts`, which webpack and
    // Turbopack both resolve as written, so neither needs an extensionAlias.
    // `next dev --turbopack` skips webpack() below and needs nothing in its
    // place: serverExternalPackages covers pg, and the static assets are
    // copied as this config loads. Builds stay on webpack.
    turbopack: {},
    webpack:(config, { isServer, nextRuntime }) => {
      if (!isServer) {
        const outputPath = config.output.path ?? path.join(__dirname, '.next');
        config.plugins.push(new CopyPlugin({ patterns: staticAssetCopies(outputPath) }));
      }
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
      afterFiles: (() => {
        const origin =
          phase === PHASE_DEVELOPMENT_SERVER ? webAppInternalOrigin() : apiProxyOrigin();
        return origin ? [apiProxy(origin)] : [];
      })(),
      fallback: [{ source: "/api/:path*", ...prefetchDocument() }],
    }),
  };
}
