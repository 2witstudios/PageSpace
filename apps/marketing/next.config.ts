import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  assetPrefix: '/_marketing',
  images: {
    path: '/_marketing/_next/image',
    // AVIF first: the hero backdrop is a full-bleed photo and AVIF lands it
    // ~30-40% smaller than WebP at the same quality.
    formats: ['image/avif', 'image/webp'],
    // Next 16 requires every non-default quality to be declared. 90 is the hero
    // backdrop; 75 stays the default for everything else.
    qualities: [75, 90],
  },
  // Apple requires the AASA file be served as application/json. It is
  // deliberately extensionless, so Next's static handler would otherwise send
  // application/octet-stream and Apple's CDN would reject the file — which is
  // exactly how universal links silently never activated.
  async headers() {
    return [
      {
        source: '/.well-known/apple-app-site-association',
        headers: [{ key: 'Content-Type', value: 'application/json' }],
      },
    ];
  },
  async redirects() {
    return [
      { source: '/docs/mcp', destination: '/docs/integrations/mcp', permanent: true },
      { source: '/docs/mcp/desktop', destination: '/docs/integrations/mcp/desktop', permanent: true },
    ];
  },
};

export default nextConfig;
