import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  assetPrefix: '/_marketing',
  images: {
    path: '/_marketing/_next/image',
  },
  async redirects() {
    return [
      { source: '/docs/mcp', destination: '/docs/integrations/mcp', permanent: true },
      { source: '/docs/mcp/desktop', destination: '/docs/integrations/mcp/desktop', permanent: true },
    ];
  },
};

export default nextConfig;
