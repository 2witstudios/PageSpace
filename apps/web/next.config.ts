import type { NextConfig } from "next";
import path from "path";
import CopyPlugin from "copy-webpack-plugin";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../.."),
  transpilePackages: ["@pagespace/db", "@pagespace/lib"],
  // pg is listed here so Next.js skips it in client bundles; the server-side
  // @pagespace/db and pg externalization is handled in the webpack function
  // below because bun workspace symlinks resolve to paths outside node_modules,
  // causing Next.js's serverExternalPackages path-based check to miss them.
  serverExternalPackages: ["pg"],
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Externalize @pagespace/db and pg by intercepting module requests before
      // webpack resolves them. serverExternalPackages alone doesn't catch these
      // with bun because bun workspace symlinks resolve to packages/db/ which
      // has no node_modules in the path, failing Next.js's detection heuristic.
      const bunDbExternals = (
        { request }: { context: string; request: string },
        callback: (err?: Error | null, result?: string) => void
      ) => {
        if (
          request === 'pg' || request === 'pg-pool' || request === 'pg-protocol' ||
          request === 'pg-native' || request.startsWith('@pagespace/db')
        ) {
          return callback(null, `commonjs ${request}`);
        }
        callback();
      };

      if (Array.isArray(config.externals)) {
        config.externals.push(bunDbExternals);
      } else if (config.externals) {
        config.externals = [config.externals as never, bunDbExternals];
      } else {
        config.externals = [bunDbExternals];
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
