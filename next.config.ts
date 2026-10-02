import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
   * Database adapters are loaded through an intentionally bundler-invisible
   * Node require in src/lib/db.ts so Node-only drivers do not enter client
   * bundles. Include those runtime packages explicitly in server output traces;
   * otherwise a serverless deployment can omit them even though they are
   * production dependencies.
   */
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/@libsql/**/*",
      "./node_modules/@prisma/adapter-pg/**/*",
      "./node_modules/@prisma/debug/**/*",
      "./node_modules/@prisma/driver-adapter-utils/**/*",
      "./node_modules/pg/**/*",
      "./node_modules/pg-cloudflare/**/*",
      "./node_modules/pg-connection-string/**/*",
      "./node_modules/pg-int8/**/*",
      "./node_modules/pg-pool/**/*",
      "./node_modules/pg-protocol/**/*",
      "./node_modules/pg-types/**/*",
      "./node_modules/pgpass/**/*",
      "./node_modules/postgres-array/**/*",
      "./node_modules/postgres-bytea/**/*",
      "./node_modules/postgres-date/**/*",
      "./node_modules/postgres-interval/**/*",
      "./node_modules/split2/**/*",
      "./node_modules/xtend/**/*",
    ],
  },
  allowedDevOrigins: ['*.monkeycode-ai.live', '**.monkeycode-ai.live'],
  experimental: {
    /*
     * Bound build parallelism. Next defaults experimental.cpus to core-count
     * minus one (e.g. 63 workers on a 64-core CI host), which spawns dozens of
     * static-generation workers and gets OOM-killed in memory-constrained
     * sandbox/CI environments. A small worker pool builds the same output
     * with far less memory.
     */
    cpus: 2,
    staticGenerationMaxConcurrency: 4,
    staticGenerationMinPagesPerWorker: 16,
  },
};

export default nextConfig;
