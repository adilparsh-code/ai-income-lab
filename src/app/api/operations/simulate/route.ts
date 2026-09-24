import { NextResponse } from 'next/server';
import { runSimulation } from '@/lib/operations/simulation';
import { guardBrowserOrOperator, readJsonBody } from '@/lib/security/guard';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const guard = await guardBrowserOrOperator(request, 'api:operations/simulate', { max: 20, windowSeconds: 60 });
  if ('response' in guard) return NextResponse.json(guard.response, { status: guard.status });
  const body = await readJsonBody(request, { surface: 'api:operations/simulate', maxChars: 4000 });
  if (!body.ok) return NextResponse.json({ ok: false, error: body.error }, { status: body.status });
  const value = body.value;
  const numbers = ['seed', 'visitors', 'conversionRate', 'priceUsd', 'costPerVisitorUsd', 'fixedCostUsd'];
  const parsed: Record<string, number> = {};
  for (const key of numbers) {
    const candidate = value[key];
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) return NextResponse.json({ ok: false, error: `${key} must be a finite number` }, { status: 400 });
    parsed[key] = candidate;
  }
  if (parsed.visitors < 0 || parsed.conversionRate < 0 || parsed.conversionRate > 1 || parsed.priceUsd < 0 || parsed.costPerVisitorUsd < 0 || parsed.fixedCostUsd < 0) return NextResponse.json({ ok: false, error: 'Simulation inputs must be non-negative and conversionRate must be <= 1' }, { status: 400 });
  return NextResponse.json({ ok: true, result: runSimulation(parsed as never) });
}
