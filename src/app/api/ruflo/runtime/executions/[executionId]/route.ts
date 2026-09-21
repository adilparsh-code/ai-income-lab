// Ruflo runtime execution lookup — lets the orchestrator trace ONE execution
// end-to-end by executionId (= correlationId): WorkflowRun status + every
// dispatched JobRun (safe fields only: no payloads, no prompts, no secrets).
//
// GET /api/ruflo/runtime/executions/:executionId  (bearer RUFLO_RUNTIME_TOKEN)

import { NextResponse } from 'next/server';
import {
  getRufloExecution,
  requireRufloRuntime,
  rufloIpThrottle,
} from '@/lib/ruflo/runtime';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ executionId: string }> },
) {
  const throttle = await rufloIpThrottle(request, 'ruflo:runtime:executions');
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

  const { executionId } = await params;
  if (typeof executionId !== 'string' || executionId.trim().length === 0 || executionId.length > 128) {
    return NextResponse.json({ ok: false, error: 'executionId is required (max 128 chars).' }, { status: 400 });
  }

  try {
    const view = await getRufloExecution(executionId);
    // Unknown ids are a 200 with found:false so the runtime can poll without
    // error semantics; nothing is fabricated for unknown executions.
    return NextResponse.json({ ok: true, execution: view });
  } catch {
    return NextResponse.json({ ok: false, error: 'Execution lookup failed. Check the server logs.' }, { status: 500 });
  }
}
