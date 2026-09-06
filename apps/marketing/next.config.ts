import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  assetPrefix: '/_marketing',
  images: {
    path: '/_marketing/_next/image',
    // AVIF first: the hero backdrop is a full-bleed photo and AVIF lands it
    // ~30-40% smaller than WebP at the same quality.
    formats: ['image/avif', 'image/webp'],
  },
  async redirects() {
    return [
      { source: '/docs/mcp', destination: '/docs/integrations/mcp', permanent: true },
      { source: '/docs/mcp/desktop', destination: '/docs/integrations/mcp/desktop', permanent: true },
    ];
  },
};

export default nextConfig;
