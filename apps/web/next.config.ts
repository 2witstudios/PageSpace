import type { NextConfig } from "next";
import path from "path";
import MonacoWebpackPlugin from "monaco-editor-webpack-plugin";
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
      config.plugins.push(
        new MonacoWebpackPlugin({
          languages: ["javascript", "typescript", "html", "css", "json"],
          filename: "static/[name].worker.js",
        }),
        new CopyPlugin({
          patterns: [{
            from: require.resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
            to: path.join(__dirname, "public", "pdf.worker.min.mjs"),
          }],
        })
      );
    }
    return config;
  },
};

export default nextConfig;
