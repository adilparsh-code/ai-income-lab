import { NextResponse } from 'next/server';
import { createMission, startMission, completeMission, cancelMission, getMission } from '@/lib/operations/missions';
import { guardBrowserOrOperator, readJsonBody } from '@/lib/security/guard';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const guard = await guardBrowserOrOperator(request, 'api:missions', { max: 20, windowSeconds: 60 });
  if ('response' in guard) return NextResponse.json(guard.response, { status: guard.status });
  const body = await readJsonBody(request, { surface: 'api:missions', maxChars: 12000 });
  if (!body.ok) return NextResponse.json({ ok: false, error: body.error }, { status: body.status });
  const value = body.value;
  if (value.action === 'cancel' || value.action === 'complete' || value.action === 'start') {
    if (typeof value.id !== 'string' || value.id.length > 128) return NextResponse.json({ ok: false, error: 'id is required' }, { status: 400 });
    const mission = value.action === 'cancel' ? await cancelMission(value.id) : value.action === 'complete' ? await completeMission(value.id, value.success === true, typeof value.reason === 'string' ? value.reason : '') : await startMission(value.id);
    return NextResponse.json({ ok: true, mission });
  }
  if (typeof value.objective !== 'string' || typeof value.agentType !== 'string' || typeof value.correlationId !== 'string') return NextResponse.json({ ok: false, error: 'objective, agentType, and correlationId are required' }, { status: 400 });
  try {
    const mission = await createMission({ ...value, deadlineAt: typeof value.deadlineAt === 'string' ? new Date(value.deadlineAt) : undefined } as never);
    return NextResponse.json({ ok: true, mission }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Mission could not be created.' }, { status: 400 });
  }
}

export async function GET(request: Request) {
  const guard = await guardBrowserOrOperator(request, 'api:missions:get', { max: 30, windowSeconds: 60 });
  if ('response' in guard) return NextResponse.json(guard.response, { status: guard.status });
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, error: 'id is required' }, { status: 400 });
  return NextResponse.json({ ok: true, mission: await getMission(id) });
}
