import type { NextConfig } from "next";
import path from "path";
import CopyPlugin from "copy-webpack-plugin";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@pagespace/db", "@pagespace/lib"],
  webpack: (config, { isServer }) => {
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
    // @gridland/web requires bun:ffi at build time — alias to its shipped browser shims.
    const gridlandShims = path.join(__dirname, "node_modules/@gridland/web/src/shims");
    const bunFfiShim = path.join(gridlandShims, "bun-ffi.ts");
    config.resolve.alias = {
      ...config.resolve.alias,
      "bun:ffi": bunFfiShim,
      "bun-ffi-structs": path.join(gridlandShims, "bun-ffi-structs.ts"),
      bun: bunFfiShim,
    };

    return config;
  },
};

export default nextConfig;
