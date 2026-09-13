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
};

export default nextConfig;
