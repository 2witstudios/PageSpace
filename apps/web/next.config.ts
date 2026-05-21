import type { NextConfig } from "next";
import path from "path";
import CopyPlugin from "copy-webpack-plugin";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../.."),
  // @pagespace/db and @pagespace/lib are pre-built CommonJS packages (dist/).
  // With bun workspaces, keeping them in transpilePackages causes Next.js to
  // wrap the user externals and prevent those packages from being externalized,
  // so the server bundle ends up dragging in pg → util/types (a Node built-in),
  // failing the build. Removing them lets the server externals function below
  // externalize them by request name before webpack follows bun's symlinks.
  transpilePackages: [],
  // pg resolves via bun's cache path (~/.bun/install/cache/pg@.../), which
  // contains no "node_modules" segment, so Next.js's path-based heuristic
  // fails to auto-externalize it. List it explicitly here as a backstop; the
  // webpack function below handles @pagespace/db and @pagespace/lib the same way.
  serverExternalPackages: ["pg"],
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Externalize @pagespace/db, @pagespace/lib, and pg by intercepting module
      // requests before webpack resolves them. serverExternalPackages alone
      // doesn't catch workspace packages with bun because bun symlinks resolve
      // to packages/db/ and packages/lib/ (outside node_modules), failing
      // Next.js's path-based detection heuristic.
      const bunWorkspaceExternals = (
        { request }: { context: string; request: string },
        callback: (err?: Error | null, result?: string) => void
      ) => {
        if (
          request === 'pg' || request === 'pg-pool' || request === 'pg-protocol' ||
          request === 'pg-native' ||
          request.startsWith('@pagespace/db') ||
          request.startsWith('@pagespace/lib')
        ) {
          return callback(null, `commonjs ${request}`);
        }
        callback();
      };

      if (Array.isArray(config.externals)) {
        config.externals.push(bunWorkspaceExternals);
      } else if (config.externals) {
        config.externals = [config.externals as never, bunWorkspaceExternals];
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

export default nextConfig;
