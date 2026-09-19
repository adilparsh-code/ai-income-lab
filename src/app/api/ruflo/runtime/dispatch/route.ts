// Ruflo runtime dispatch API — the ONLY inbound execution path for an
// external Ruflo runtime.
//
// POST /api/ruflo/runtime/dispatch
//   body: { workflowType, objective, opportunityId?, executionId? }
//
// SECURITY CHAIN (unchanged, authoritative):
//   bearer RUFLO_RUNTIME_TOKEN (constant-time, throttled)
//     → per-IP throttle
//     → strict body guard (size caps, strict object, pollution-safe)
//     → runtime dispatch (Ruflo runtime module)
//         → workflow-level idempotency by executionId
//         → dispatchWorkflowViaRuflo()  [existing connector seam]
//         → executeWorkflow()           [existing planner + halal gates]
//         → runJob()                    [existing Job Runner: idempotency,
//                                        bounded retries, gates]
//     → durable WorkflowRun/JobRun/AgentLog + SecurityEvent audit
//
// Ruflo can never bypass authentication, rate limiting, the body guard,
// halal gates, Job Runner rules, idempotency, or audit logging.

import { NextResponse } from 'next/server';
import { logger } from '@/lib/server-log';
import {
  dispatchForRufloRuntime,
  requireRufloRuntime,
  rufloIpThrottle,
} from '@/lib/ruflo/runtime';
import { readJsonBody } from '@/lib/security/guard';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const throttle = await rufloIpThrottle(request, 'ruflo:runtime:dispatch');
  if (!throttle.ok) {
    return NextResponse.json(
      { ok: false, error: 'Rate limit exceeded. Retry later.' },
      { status: 429, headers: { 'retry-after': String(throttle.retryAfterSeconds) } },
    );
  }
  const auth = await requireRufloRuntime(request);
  if (!auth.ok) {
    logger.warn('Ruflo runtime dispatch refused', { status: auth.status });
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const bodyGuard = await readJsonBody(request, { surface: 'ruflo:runtime:dispatch', maxBytes: 32 * 1024, maxChars: 12_000 });
  if (!bodyGuard.ok) {
    return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  }
  const raw = bodyGuard.value;

  // Strict field validation before anything executes.
  const outcome = await dispatchForRufloRuntime({
    workflowType: typeof raw.workflowType === 'string' ? raw.workflowType : '',
    objective: typeof raw.objective === 'string' ? raw.objective : '',
    ...(typeof raw.opportunityId === 'string' ? { opportunityId: raw.opportunityId } : {}),
    ...(typeof raw.executionId === 'string' ? { executionId: raw.executionId } : {}),
  });

  if (!outcome.accepted) {
    const status = outcome.status === 'INVALID' ? 400 : outcome.status === 'TIMEOUT' ? 504 : 503;
    logger.warn('Ruflo runtime dispatch not accepted', { status: outcome.status });
    return NextResponse.json({ ok: false, dispatch: outcome }, { status });
  }

  // 200 for duplicates (idempotent replay), 202 for fresh accepted dispatches.
  return NextResponse.json({ ok: true, dispatch: outcome }, { status: outcome.duplicate ? 200 : 202 });
}
