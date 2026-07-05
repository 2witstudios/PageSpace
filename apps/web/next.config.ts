import type { NextConfig } from "next";
import path from "path";
import fs from "fs";
import CopyPlugin from "copy-webpack-plugin";
import { withSentryConfig } from "@sentry/nextjs";
import { WELL_KNOWN_REWRITES } from "./src/lib/well-known/rewrites";

// Guard: only externalize workspace packages when running in production AND
// their dist directories exist. The production check prevents stale dist/
// directories from silently overriding source edits during `bun run dev`.
// Docker builds always run with NODE_ENV=production and pre-build packages
// before this file is evaluated, so both conditions are satisfied there.
const dbDistExists = fs.existsSync(path.resolve(__dirname, "../../packages/db/dist"));
const libDistExists = fs.existsSync(path.resolve(__dirname, "../../packages/lib/dist"));
const workspaceDistReady =
  process.env.NODE_ENV === "production" && dbDistExists && libDistExists;

// Named export so tests can assert on rewrites()/redirects() without going
// through withSentryConfig's wrapping.
export const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../.."),
  transpilePackages: workspaceDistReady ? [] : ["@pagespace/db", "@pagespace/lib"],
  // Preserve RFC 8252 loopback redirect_uri query values; NextRequest URL
  // normalization rewrites percent-encoded 127.0.0.1 to localhost otherwise.
  skipMiddlewareUrlNormalize: true,
  // pg resolves via bun's cache path (~/.bun/install/cache/pg@.../), which
  // contains no "node_modules" segment, so Next.js's path-based heuristic
  // fails to auto-externalize it. List it explicitly here as a backstop; the
  // webpack function below handles @pagespace/db and @pagespace/lib the same way.
  // NOTE: @fly/sprites must NOT be listed here. serverExternalPackages makes
  // Next.js emit require() at runtime, which fails for ESM-only packages. Instead
  // it is a direct dependency of apps/web so webpack bundles it as a server chunk.
  serverExternalPackages: ["pg"],
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Externalize pg unconditionally (bun cache path bypasses Next's heuristic).
      // When workspaceDistReady, also externalize @pagespace/db and @pagespace/lib
      // so Next emits require('@pagespace/...') calls resolved to their dist/.
      const bunWorkspaceExternals = (
        { request }: { context: string; request: string },
        callback: (err?: Error | null, result?: string) => void
      ) => {
        if (
          request === 'pg' || request === 'pg-pool' || request === 'pg-protocol' ||
          request === 'pg-native' ||
          (workspaceDistReady && (
            request.startsWith('@pagespace/db') ||
            request.startsWith('@pagespace/lib')
          ))
        ) {
          return callback(null, `commonjs ${request}`);
        }
        callback();
      };

      if (Array.isArray(config.externals)) {
        config.externals.push(bunWorkspaceExternals);
      } else if (config.externals) {
        config.externals = [config.externals as NonNullable<typeof config.externals>, bunWorkspaceExternals];
      } else {
        config.externals = [bunWorkspaceExternals];
      }
    }
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        dns: false,
        net: false,
        tls: false,
        'pg-native': false,
        process: false,
        os: false,
      };
      const outputPath = config.output.path ?? path.join(__dirname, ".next");

      config.plugins.push(
        new CopyPlugin({
          patterns: [
            {
              from: path.dirname(require.resolve("monaco-editor/min/vs/loader.js")),
              to: path.join(outputPath, "static", "monaco", "vs"),
            },
            {
              from: require.resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
              to: path.join(__dirname, "public", "pdf.worker.min.mjs"),
            },
          ],
        })
      );

    }

    return config;
  },
  async redirects() {
    return [
      { source: '/dashboard/inbox/channel/:pageId', destination: '/dashboard/channels/:pageId', permanent: false },
      { source: '/dashboard/inbox/dm/:conversationId', destination: '/dashboard/dms/:conversationId', permanent: false },
      { source: '/dashboard/messages/:conversationId', destination: '/dashboard/dms/:conversationId', permanent: false },
      { source: '/dashboard/inbox/new', destination: '/dashboard/dms/new', permanent: false },
      { source: '/dashboard/inbox', destination: '/dashboard/dms', permanent: false },
      { source: '/dashboard/:driveId/inbox', destination: '/dashboard/:driveId/channels', permanent: false },
    ];
  },
  async rewrites() {
    // beforeFiles: /.well-known/* must be rewritten BEFORE Next's filesystem +
    // prerender check, otherwise the prerendered 404 for that namespace (Next
    // treats it as static because public/.well-known/ exists) wins and the
    // afterFiles rewrite never fires. See RFC 8414 discovery — pagespace-cli.
    return { beforeFiles: [...WELL_KNOWN_REWRITES] };
  },
};

const sentryBuildOptions = {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  silent: !process.env.CI,
  tunnelRoute: "/sentry-tunnel",
  authToken: process.env.SENTRY_AUTH_TOKEN,
  widenClientFileUpload: true,
};
export default withSentryConfig(nextConfig, sentryBuildOptions);
