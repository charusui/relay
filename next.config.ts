import type { NextConfig } from 'next';

// The Next.js app (app/) is the deployed face of Relay: the monitoring dashboard,
// the Twilio SMS webhook and the daily synthetic check. It imports the same
// src/ code the CLI, tests and evals use.
const config: NextConfig = {
  // Type checking runs through `npm run typecheck` (TypeScript 7), not Next's build step.
  typescript: { ignoreBuildErrors: true, tsconfigPath: 'tsconfig.next.json' },
  // Database drivers stay as normal Node modules instead of being bundled (PGlite ships WASM).
  serverExternalPackages: ['@electric-sql/pglite', 'pg'],
  // Files the agent reads at runtime: policies, prompts and the price table.
  outputFileTracingIncludes: {
    '/**': ['./data/policies/**', './data/prices.json', './src/agent/prompts/**'],
  },
  poweredByHeader: false,
};

export default config;
