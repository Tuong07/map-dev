import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The tracer writes JSON straight to disk through a dev-only route. Nothing
  // else needs server behaviour, so the app stays trivially deployable.
  reactStrictMode: true,
};

export default nextConfig;
