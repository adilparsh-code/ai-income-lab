// Phase 4.5.2 — Job inspection API.
// GET /api/jobs/:id → safe status detail for one job. Returns job metadata
// and the compact output summary — never the raw agent input payload,
// prompts, or secrets.

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
    return NextResponse.json({ ok: false, error: 'Invalid job id' }, { status: 400 });
  }

  try {
    const row = await db.jobRun.findUnique({ where: { id } });
    if (!row) {
      return NextResponse.json({ ok: false, error: 'Job not found' }, { status: 404 });
    }

    // output/resultRef were written by the runner as compact safe summaries.
    let output: unknown = null;
    try { output = row.output ? JSON.parse(row.output) : null; } catch { output = null; }
    let resultRef: unknown = null;
    try { resultRef = row.resultRef ? JSON.parse(row.resultRef) : null; } catch { resultRef = null; }

    return NextResponse.json({
      ok: true,
      job: {
        id: row.id,
        jobType: row.jobType,
        status: row.status,
        correlationId: row.correlationId,
        opportunityId: row.opportunityId,
        agentType: row.agentType,
        executionMode: row.executionMode,
        retryCount: row.retryCount,
        createdAt: row.createdAt.toISOString(),
        startedAt: row.startedAt?.toISOString() ?? null,
        completedAt: row.completedAt?.toISOString() ?? null,
        error: row.error,
        output,
        resultRef,
        // Deliberately omitted: `input` (agent payload), raw output payloads.
      },
    });
  } catch {
    return NextResponse.json({ ok: false, error: 'Job lookup failed. Check the server logs.' }, { status: 500 });
  }
}
