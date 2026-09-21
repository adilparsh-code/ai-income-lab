// Phase 5.5 — Ruflo connector API.
//
// GET  /api/ruflo/connector → the honest Ruflo integration status
//                              (RUFLO_READY / NOT_CONNECTED / RUFLO_CONNECTED).
// POST /api/ruflo/connector → REFUSES handle registration over HTTP by design.
//
// Why POST refuses: an orchestrator handle is privileged server-side wiring
// (it receives completion callbacks and becomes a dispatch entry point).
// Accepting arbitrary handle registrations from the network would create an
// unauthenticated execution path — the exact bypass this architecture exists
// to prevent. Registration happens only in server-side operator code via
// registerRufloOrchestrator(). Nothing here fakes a connection.

import { NextResponse } from 'next/server';
import { describeRufloIntegration } from '@/lib/ruflo/capability';

export const dynamic = 'force-dynamic';

export async function GET() {
  const status = describeRufloIntegration();
  return NextResponse.json({ ok: true, ruflo: status });
}

export async function POST() {
  return NextResponse.json(
    {
      ok: false,
      error:
        'Ruflo orchestrator handles cannot be registered over HTTP. '
        + 'Registration is a server-side operator action (registerRufloOrchestrator) so that no '
        + 'unauthenticated dispatch path can exist. Status remains as reported by GET.',
    },
    { status: 403 },
  );
}
