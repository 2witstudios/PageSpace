import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  assetPrefix: '/_marketing',
  images: {
    path: '/_marketing/_next/image',
  },
};

export default nextConfig;
