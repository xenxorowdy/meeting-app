import type { NextConfig } from 'next';

// The parent monorepo has its own package-lock.json, so without an explicit root Next would infer
// packages/meeting-app as the workspace and trace the Electron app's node_modules into the build.
const root = __dirname;

const nextConfig: NextConfig = {
    turbopack: { root },
    outputFileTracingRoot: root,
    poweredByHeader: false,
};

export default nextConfig;
