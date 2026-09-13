// Server-only configuration.
// IMPORTANT: Do NOT import this module from client components ("use client").
// Anything exported here may be evaluated server-side only (e.g. build/SSR/runtime),
// and must never be embedded into client bundles. Client-safe values are prefixed
// NEXT_PUBLIC_ in the environment and exposed explicitly where needed.

export type AppEnvironment = 'development' | 'production' | 'test';

// Environment this process is running as. Explicit APP_ENV wins; otherwise fall
// back to Next's NODE_ENV (set to 'production' for deploys and prod builds).
export const APP_ENV: AppEnvironment =
  (process.env.APP_ENV as AppEnvironment) || (process.env.NODE_ENV === 'production' ? 'production' : 'development');

// True when running in a deployed/production build (Next sets NODE_ENV=production).
export const isDeployed = process.env.NODE_ENV === 'production';

// Client-safe display name. Only NEXT_PUBLIC_* values are safe to expose; never
// put secrets behind a NEXT_PUBLIC_ prefix.
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || 'AI Income Lab';

/**
 * Read a required server-side environment variable.
 * Throws with a clear, safe message if missing — never returns or logs the value.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Environment variable "${name}" is required but not set. Configure it in your deployment environment.`);
  }
  return value;
}

/**
 * Read the production/release database connection string.
 * In production this must be explicitly configured — never silently fall back to
 * a local file (which would be non-persistent on serverless platforms).
 */
export function resolveDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (isDeployed && !value) {
    throw new Error('DATABASE_URL must be set in the production environment. Configure it via your deployment platform\'s environment variables.');
  }
  return value || 'file:./dev.db';
}