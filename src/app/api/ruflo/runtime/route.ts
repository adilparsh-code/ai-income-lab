// Ruflo runtime API — status + health (authenticated, server-to-server).
//
// GET  /api/ruflo/runtime         → capability status (5-state machine).
// POST /api/ruflo/runtime/health  → REAL verification: boundary contracts +
//                                   database reachability; recorded durably in
//                                   the SecurityEvent audit trail. This is the
//                                   only thing that can move the capability to
//                                   CONNECTED (within its freshness window).
//
// SECURITY: both endpoints require the RUFLO_RUNTIME_TOKEN bearer credential
// (constant-time compare, brute-force throttled). Rate limits are durable
// (DB-backed). No secrets are ever returned; only the non-secret runtime id.

import { NextResponse } from 'next/server';
import { logger } from '@/lib/server-log';
import {
  describeRufloRuntime,
  requireRufloRuntime,
  rufloIpThrottle,
  verifyRufloRuntime,
} from '@/lib/ruflo/runtime';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const throttle = await rufloIpThrottle(request, 'ruflo:runtime:get');
  if (!throttle.ok) {
    return NextResponse.json(
      { ok: false, error: 'Rate limit exceeded. Retry later.' },
      { status: 429, headers: { 'retry-after': String(throttle.retryAfterSeconds) } },
    );
  }
  const auth = await requireRufloRuntime(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }
  const capability = await describeRufloRuntime();
  return NextResponse.json({ ok: true, ruflo: capability });
}

export async function POST(request: Request) {
  const throttle = await rufloIpThrottle(request, 'ruflo:runtime:health');
  if (!throttle.ok) {
    return NextResponse.json(
      { ok: false, error: 'Rate limit exceeded. Retry later.' },
      { status: 429, headers: { 'retry-after': String(throttle.retryAfterSeconds) } },
    );
  }
  const auth = await requireRufloRuntime(request);
  if (!auth.ok) {
    logger.warn('Ruflo runtime health refused', { status: auth.status });
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }
  try {
    const verdict = await verifyRufloRuntime();
    const status = verdict.status === 'CONNECTED' ? 200 : verdict.status === 'AUTH_REQUIRED' ? 503 : 500;
    return NextResponse.json({ ok: verdict.status === 'CONNECTED', health: verdict }, { status });
  } catch (error) {
    logger.error('Ruflo runtime health check failed', error);
    return NextResponse.json({ ok: false, error: 'Health check failed. Nothing was verified.' }, { status: 500 });
  }
}
