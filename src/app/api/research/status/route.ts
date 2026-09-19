import { NextResponse } from 'next/server';
import { getResearchEngineStatus } from '@/actions/research';
import { guardBrowserOrOperator } from '@/lib/security/guard';

/**
 * Research engine status endpoint. Exposes only non-secret configuration
 * state: which AI mode is active and whether search discovery is configured.
 */
export async function GET(request: Request) {
  // SECURITY: configuration posture is operational data. The server-rendered
  // app UI may read it (same-origin); outside callers need the operator
  // credential. Rate-limited either way.
  const guard = await guardBrowserOrOperator(request, 'api:research/status', { max: 60, windowSeconds: 60 });
  if ('response' in guard) {
    return NextResponse.json(guard.response, { status: guard.status });
  }
  try {
    const status = getResearchEngineStatus();
    return NextResponse.json(await status);
  } catch (error) {
    console.error('research status failed', error);
    return NextResponse.json(
      {
        aiProvider: 'unknown',
        aiLive: false,
        searchProviderId: null,
        searchConfigured: false,
        searchHint: 'Status unavailable.',
        summary: 'Research engine status is unavailable.',
      },
      { status: 200 },
    );
  }
}
