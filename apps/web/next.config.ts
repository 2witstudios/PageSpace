import type { NextConfig } from "next";
import path from "path";
import fs from "fs";
import CopyPlugin from "copy-webpack-plugin";
import { withSentryConfig } from "@sentry/nextjs";

// Guard: only externalize workspace packages when running in production AND
// their dist directories exist. The production check prevents stale dist/
// directories from silently overriding source edits during `bun run dev`.
// Docker builds always run with NODE_ENV=production and pre-build packages
// before this file is evaluated, so both conditions are satisfied there.
const dbDistExists = fs.existsSync(path.resolve(__dirname, "../../packages/db/dist"));
const libDistExists = fs.existsSync(path.resolve(__dirname, "../../packages/lib/dist"));
const workspaceDistReady =
  process.env.NODE_ENV === "production" && dbDistExists && libDistExists;

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../.."),
  transpilePackages: workspaceDistReady ? [] : ["@pagespace/db", "@pagespace/lib"],
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

      // @gridland/web requires bun:ffi at build time — alias to its shipped browser shims.
      const gridlandShims = path.join(__dirname, "node_modules/@gridland/web/src/shims");
      const bunFfiShim = path.join(gridlandShims, "bun-ffi.ts");
      config.resolve.alias = {
        ...config.resolve.alias,
        "bun:ffi": bunFfiShim,
        "bun-ffi-structs": path.join(gridlandShims, "bun-ffi-structs.ts"),
        bun: bunFfiShim,
      };

      // @gridland/web's dist ships a module-local `var process = { env: ... }`
      // that omits `nextTick`, yet its scroll-box calls `process.nextTick(...)`
      // to defer a render request out of the current pass. In the browser that
      // throws `TypeError: B.nextTick is not a function`, breaking the whole
      // app on any page rendering a terminal. Patch the dist at build time to
      // attach a working `nextTick` (backed by queueMicrotask) to that object.
      // Targeted to gridland's bundle only; the guard makes it a no-op if the
      // upstream shape changes.
      config.module = config.module ?? {};
      config.module.rules = [
        ...(config.module.rules ?? []),
        {
          test: /node_modules\/@gridland\/web\/dist\/[^/]+\.js$/,
          loader: path.join(__dirname, "webpack-loaders", "gridland-process-nexttick.cjs"),
        },
      ];
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
