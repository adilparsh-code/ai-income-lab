// HIGH-1 — Authenticated opportunity handoff receiver (HTTP boundary).
//
// POST /api/handoff/receive
//
// Receives an opportunity proposal from an external agent sender. The route is
// deliberately thin: it performs transport-level concerns only (operator auth,
// rate limit, body bounds) and delegates every domain decision to
// receiveHandoff().
//
// SECURITY MODEL (fail-closed):
// - Reuses the EXISTING operator credential gate (requireOperator). No second
//   authentication system exists. With no credential configured server-side,
//   every request is refused with 503 (NOT_CONFIGURED) and nothing is
//   processed or fabricated.
// - Rate limited per-IP through the existing DB-backed limiter, so this can
//   never become an unlimited public job-submission endpoint.
// - The body is size-capped and strictly parsed BEFORE any domain logic.
// - The receiver NEVER executes agents/AI directly; it hands off to the Job
//   Runner, which remains authoritative for lifecycle, retries, safety gates
//   and audit.
// - Error responses are generic. No credentials, prompts or raw payloads are
//   ever echoed back or logged.

import { NextResponse } from 'next/server';
import { logger } from '@/lib/server-log';
import { db } from '@/lib/db';
import { runJob } from '@/lib/jobs/job-runner';
import { enforceRateLimit, clientIpFrom, readJsonBody, requireOperator } from '@/lib/security/guard';
import { receiveHandoff, type HandoffDb } from '@/lib/integrations/handoff-receiver';

export const dynamic = 'force-dynamic';

const SURFACE = 'api:handoff:receive';
const MAX_BODY_CHARS = 24_000;

export async function POST(request: Request) {
  // ---- RATE LIMIT (existing infrastructure, fail-closed on refusal) -----
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: SURFACE, identity: ip, max: 20, windowSeconds: 60 });
  if (!limit.allowed) {
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }

  // ---- AUTH (existing operator credential gate) --------------------------
  const auth = await requireOperator(request, SURFACE);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  // ---- BODY (bounded + strictly parsed) ---------------------------------
  const bodyGuard = await readJsonBody(request, { surface: SURFACE, maxChars: MAX_BODY_CHARS });
  if (!bodyGuard.ok) {
    return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  }

  try {
    const result = await receiveHandoff(bodyGuard.value, {
      db: db as unknown as HandoffDb,
      senderIdentity: auth.identity,
      runJob: (jobType, payload, correlationId) => runJob(jobType, payload, correlationId),
    });

    if (!result.ok) {
      return NextResponse.json(
        {
          ok: false,
          handoff: result.handoff,
          error: result.error,
          ...(result.errors ? { errors: result.errors } : {}),
        },
        { status: result.status },
      );
    }

    return NextResponse.json(
      {
        ok: true,
        handoff: result.handoff,
        idempotencyKey: result.idempotencyKey,
        correlationId: result.correlationId,
        jobRunId: result.jobRunId ?? null,
        duplicate: result.duplicate,
        detail: result.detail,
      },
      { status: result.status },
    );
  } catch {
    logger.error('Handoff receiver failed', { error: String('handoff processing error') });
    return NextResponse.json(
      { ok: false, error: 'Receiver failed unexpectedly. No work was executed.' },
      { status: 500 },
    );
  }
}
