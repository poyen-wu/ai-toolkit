import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  devIndicators: {
    buildActivity: false,
  },
  typescript: {
    // Remove this. Build fails because of route types
    ignoreBuildErrors: true,
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '100mb',
    },
    middlewareClientMaxBodySize: '100mb',
  },

  // Keep our existing small webpack tweaks.
  webpack: (config, { isServer }) => {
    // Next.js sometimes tries to polyfill node:fs for client builds; parquet import is server-only.
    if (!isServer) {
      config.resolve.fallback = { ...(config.resolve.fallback || {}), fs: false };
    }

    return config;
  },
};

export default nextConfig;
