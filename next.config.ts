import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
   * The Prisma client uses the @libsql adapter, which loads a platform-specific
   * native library (e.g. index.node under node_modules/@libsql) at runtime.
   * Next's output file tracing must include these native bindings so the server
   * output carries them on serverless deploys (e.g. Vercel). Without this, the
   * adapter can fail to load in production.
   */
  outputFileTracingIncludes: {
    "/*": ["./node_modules/@libsql/**/*"],
  },
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
