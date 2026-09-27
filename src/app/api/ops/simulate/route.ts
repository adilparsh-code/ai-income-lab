// POST /api/ops/simulate — paper-income simulation. Results are always SIMULATED
// and never written to the Revenue table.

import { NextResponse } from 'next/server';
import { persistSimulation, runPaperSimulation } from '@/lib/ops/simulation';
import { guardBrowserOrOperator, readJsonBody } from '@/lib/security/guard';
import { logger } from '@/lib/server-log';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const guard = await guardBrowserOrOperator(request, 'api:ops/simulate', { max: 20, windowSeconds: 60 });
  if ('response' in guard) {
    return NextResponse.json(guard.response, { status: guard.status });
  }
  const bodyGuard = await readJsonBody(request, { surface: 'api:ops/simulate', maxChars: 4_000 });
  if (!bodyGuard.ok) {
    return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  }
  const raw = bodyGuard.value;
  if (typeof raw.seed !== 'string' || raw.seed.length === 0 || raw.seed.length > 200) {
    return NextResponse.json({ ok: false, error: 'seed is required (max 200 chars).' }, { status: 400 });
  }
  if (typeof raw.correlationId !== 'string' || raw.correlationId.length === 0 || raw.correlationId.length > 200) {
    return NextResponse.json({ ok: false, error: 'correlationId is required (max 200 chars).' }, { status: 400 });
  }
  try {
    const simulated = runPaperSimulation({
      seed: raw.seed,
      correlationId: raw.correlationId,
      ...(typeof raw.opportunityId === 'string' ? { opportunityId: raw.opportunityId } : {}),
      ...(typeof raw.traffic === 'number' ? { traffic: raw.traffic } : {}),
      ...(typeof raw.conversionRate === 'number' ? { conversionRate: raw.conversionRate } : {}),
      ...(typeof raw.priceUsd === 'number' ? { priceUsd: raw.priceUsd } : {}),
      ...(typeof raw.costPerVisitorUsd === 'number' ? { costPerVisitorUsd: raw.costPerVisitorUsd } : {}),
      ...(typeof raw.fixedCostUsd === 'number' ? { fixedCostUsd: raw.fixedCostUsd } : {}),
      ...(typeof raw.failedValidationCount === 'number' ? { failedValidationCount: raw.failedValidationCount } : {}),
      ...(typeof raw.positiveValidationCount === 'number' ? { positiveValidationCount: raw.positiveValidationCount } : {}),
      ...(typeof raw.halalStatus === 'string' ? { halalStatus: raw.halalStatus } : {}),
      ...(typeof raw.highRisk === 'boolean' ? { highRisk: raw.highRisk } : {}),
    });
    const persisted = await persistSimulation(simulated, typeof raw.opportunityId === 'string' ? raw.opportunityId : undefined);
    return NextResponse.json({
      ok: true,
      simulation: persisted,
      notice: 'SIMULATED. No real transaction occurred. This is not stored as real revenue.',
    }, { status: 201 });
  } catch (error) {
    logger.error('Simulation failed', { error: String(error) });
    return NextResponse.json({ ok: false, error: 'Simulation failed. Nothing was fabricated as real revenue.' }, { status: 503 });
  }
}
