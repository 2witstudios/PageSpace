import type { NextConfig } from "next";
import path from "path";
import fs from "fs";

const dbDistExists = fs.existsSync(path.resolve(__dirname, "../../packages/db/dist"));
const libDistExists = fs.existsSync(path.resolve(__dirname, "../../packages/lib/dist"));
const workspaceDistReady = dbDistExists && libDistExists;

const nextConfig: NextConfig = {
  output: "standalone",
  async redirects() {
    return [
      { source: "/dashboard", destination: "/overview", permanent: true },
      { source: "/unit-economics", destination: "/billing", permanent: true },
      { source: "/ai-billing", destination: "/billing", permanent: true },
    ];
  },
  transpilePackages: workspaceDistReady ? [] : ["@pagespace/db", "@pagespace/lib"],
  serverExternalPackages: ["pg"],
  webpack: (config, { isServer }) => {
    if (isServer) {
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
      };
    }
    return config;
  },
};

export default nextConfig;
