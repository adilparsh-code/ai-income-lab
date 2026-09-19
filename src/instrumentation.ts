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

export async function register() {
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
