// Next.js instrumentation hook — runs once per server process start.
//
// RUFLO RUNTIME WIRING (Ruflo Live Integration Phase):
// registers the configured Ruflo runtime handle server-side, idempotently.
// With no RUFLO_RUNTIME_TOKEN configured this is a documented no-op and the
// capability honestly stays NOT_CONFIGURED. Registration is deliberately a
// server-side action only — the HTTP API refuses handle registration by
// design, so no unauthenticated dispatch path can exist.
//
// SECURITY: instrumentation runs server-side only; it is never bundled for
// the browser and never touches client code.
//
// EDGE NOTE (Vercel deploy): Next.js also compiles this file for the Edge
// sandbox that hosts the middleware (the middleware entry loads
// middleware_instrumentation at cold start). The Ruflo runtime graph below
// requires Node.js built-ins (`node:crypto` in lib/ruflo/runtime.ts, and
// `node:dns` transitively in lib/security/ssrf.ts) which do not exist on the
// Edge. Gating the wiring on process.env.NEXT_RUNTIME keeps the Node.js
// behavior identical while the Edge bundle sees a documented no-op (the
// bundler constant-folds this comparison per runtime build).
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Dynamic import so the runtime modules load after server bootstrap.
  try {
    const { setupRufloRuntime } = await import('./lib/ruflo/runtime-setup');
    const result = setupRufloRuntime();
    if (result.registered) {
      console.log(JSON.stringify({
        level: 'info',
        msg: 'Ruflo runtime integration active',
        runtimeId: result.runtimeId,
      }));
    } else {
      console.log(JSON.stringify({
        level: 'info',
        msg: 'Ruflo runtime integration inactive (documented no-op)',
        reason: result.reason.slice(0, 200),
      }));
    }
  } catch (error) {
    // Startup must never fail because of the optional Ruflo integration.
    console.warn(JSON.stringify({
      level: 'warn',
      msg: 'Ruflo runtime setup skipped due to an error',
      detail: error instanceof Error ? error.message.slice(0, 150) : 'unknown',
    }));
  }
}
