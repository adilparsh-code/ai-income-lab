// Phase 10 — Observatory view assembler.
//
// Composes the read-only observatory models into a single admin view. Purely
// additive over existing tables; nothing here writes to the database.

import { getAgentObservations } from './agent-overview';
import { getObservatoryTimeline } from './timeline';
import { epistemicStateFor, getLearningObservations } from './learning';
import { getPnlObservatory } from './pnl';
import { getCustomerInteractions, getHalalMap, getPublishingRows } from './safety-map';
import { getGitHubWatcher, getIntegrationHealth } from './integration-health';
import { getExecutiveNow, getNextActions } from './executive-view';
import type {
  CustomerInteractionView,
  ExecutiveNow,
  GitHubWatcherView,
  HalalMap,
  LearningObservation,
  NextActionsView,
  PnlObservatory,
  PublishingRow,
  TimelineEntry,
} from './types';

export interface ObservatoryView {
  generatedAt: string;
  agents: Awaited<ReturnType<typeof getAgentObservations>>;
  timeline: TimelineEntry[];
  learning: {
    entries: LearningObservation[];
    counts: Record<string, number>;
  };
  pnl: PnlObservatory;
  halal: HalalMap;
  publishing: { rows: PublishingRow[]; providerState: import('./types').IntegrationHealth };
  customerInteractions: CustomerInteractionView;
  integrations: import('./types').IntegrationHealth[];
  github: GitHubWatcherView;
  executive: ExecutiveNow;
  nextActions: NextActionsView;
}

export async function getObservatoryView(): Promise<ObservatoryView> {
  const [agents, timeline, learning, pnl, halal, publishing, customerInteractions, integrations, github, executive, nextActions] =
    await Promise.all([
      getAgentObservations(),
      getObservatoryTimeline({ limit: 80 }),
      getLearningObservations(40),
      getPnlObservatory(),
      getHalalMap(),
      getPublishingRows(20),
      getCustomerInteractions(),
      getIntegrationHealth(),
      getGitHubWatcher(),
      getExecutiveNow(),
      getNextActions(),
    ]);

  return {
    generatedAt: new Date().toISOString(),
    agents,
    timeline,
    learning: { entries: learning.entries, counts: learning.counts },
    pnl,
    halal,
    publishing,
    customerInteractions,
    integrations,
    github,
    executive,
    nextActions,
  };
}

export { epistemicStateFor, getAgentObservations, getObservatoryTimeline, getLearningObservations, getPnlObservatory, getHalalMap, getPublishingRows, getCustomerInteractions, getIntegrationHealth, getGitHubWatcher, getExecutiveNow, getNextActions };
export * from './types';
