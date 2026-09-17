import { NextResponse } from 'next/server';
import { getResearchEngineStatus } from '@/actions/research';

/**
 * Research engine status endpoint. Exposes only non-secret configuration
 * state: which AI mode is active and whether search discovery is configured.
 */
export async function GET() {
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
