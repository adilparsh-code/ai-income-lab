// Phase 5.5 — Operations API.
//
// GET  /api/operations → the truthful operations summary (jobs, workflows,
//                         products, recorded economics, next best action,
//                         capability center). Figures come from REAL DB rows;
//                         anything without evidence is labelled, not invented.
// POST /api/operations → { action: 'verify-ai-provider' } performs ONE real
//                         minimal generation round trip to move the AI
//                         capability label toward LIVE. No other action exists.
//
// SECURITY: responses contain only safe aggregates and labels — no prompts,
// no outputs, no credentials, no raw environment values.

import { NextResponse } from 'next/server';
import { logger } from '@/lib/server-log';
import { getOperationsSummary } from '@/lib/product-factory/operations';
import { verifyAiProvider } from '@/lib/ai/capability';
import { guardBrowserOrOperator, guardOperatorEndpoint, readJsonBody } from '@/lib/security/guard';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const guard = await guardBrowserOrOperator(request, 'api:operations:get', { max: 30, windowSeconds: 60 });
  if ('response' in guard) return NextResponse.json(guard.response, { status: guard.status });
  try {
    const summary = await getOperationsSummary();
    return NextResponse.json({ ok: true, summary });
  } catch (error) {
    logger.error('Operations summary failed', { error: String(error) });
    return NextResponse.json(
      { ok: false, error: 'Operations summary is temporarily unavailable (data layer error). Nothing was fabricated.' },
      { status: 503 },
    );
  }
}

export async function POST(request: Request) {
  // SECURITY: triggering a real AI provider verification costs tokens/money —
  // operator-only, rate-limited.
  const guard = await guardOperatorEndpoint(request, 'api:operations', { max: 10, windowSeconds: 60 });
  if ('response' in guard) {
    return NextResponse.json(guard.response, { status: guard.status });
  }

  const bodyGuard = await readJsonBody(request, { surface: 'api:operations', maxChars: 2_000 });
  if (!bodyGuard.ok) {
    return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  }

  const action = bodyGuard.value.action;
  if (action !== 'verify-ai-provider') {
    return NextResponse.json(
      { ok: false, error: "Unknown action. Supported: 'verify-ai-provider'." },
      { status: 400 },
    );
  }

  logger.info('AI provider verification requested');
  try {
    const capability = await verifyAiProvider();
    return NextResponse.json({ ok: true, capability });
  } catch (error) {
    logger.error('AI provider verification errored', { error: String(error) });
    return NextResponse.json(
      { ok: false, error: 'Verification failed without issuing a LIVE label. Check server logs.' },
      { status: 502 },
    );
  }
}
