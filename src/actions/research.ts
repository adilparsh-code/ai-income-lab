'use server';

import { describeSearchConfiguration } from '@/lib/research/search-provider';
import { identifyExecutionMode } from '@/lib/ai/generate';

export interface ResearchEngineStatus {
  aiProvider: string;
  aiLive: boolean;
  searchProviderId: string | null;
  searchConfigured: boolean;
  searchHint: string;
  /** Combined guidance for the UI (safe, no secrets). */
  summary: string;
}

/** Research engine configuration status for display. Never exposes secrets. */
export async function getResearchEngineStatus(): Promise<ResearchEngineStatus> {
  const mode = identifyExecutionMode();
  const search = describeSearchConfiguration();

  const aiPart = mode.isLive
    ? `AI provider "${mode.provider}" is live.`
    : 'AI provider is in deterministic mock mode (no key required).';
  const searchPart = search.configured
    ? `Search discovery via "${search.providerId}" is configured.`
    : (search.hint || 'Search discovery is not configured; nothing is fabricated without it.');

  return {
    aiProvider: mode.provider,
    aiLive: mode.isLive,
    searchProviderId: search.providerId,
    searchConfigured: search.configured,
    searchHint: search.hint,
    summary: `${aiPart} ${searchPart}`,
  };
}
