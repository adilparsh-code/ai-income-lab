// Phase 10.10 / 10.11 — Integration Health + GitHub Engineering Watcher.
//
// Health states reuse the existing capability descriptors verbatim; nothing is
// labelled CONNECTED without a real configured, verified capability behind it.
// The GitHub watcher is READ-ONLY: no GitHub client exists in this codebase
// (no GITHUB_TOKEN usage anywhere), so it truthfully reports NOT_CONNECTED and
// returns no fabricated repository activity.

import { db } from '@/lib/db';
import { describeAiCapability } from '@/lib/ai/capability';
import { describeResearchProviderHealth } from '@/lib/research/provider';
import { describeRufloIntegration } from '@/lib/ruflo/capability';
import { describeRufloRuntime } from '@/lib/ruflo/runtime';
import { describePublishingStatus } from '@/lib/publishing/contract';
import { describeVercelConfig } from '@/lib/product-factory/deployment-vercel';
import { operatorControlToken } from '@/lib/security/guard';
import type { GitHubWatcherView, IntegrationHealth } from './types';

function mapState(status: string): IntegrationHealth['state'] {
  switch (status) {
    case 'LIVE':
    case 'AVAILABLE':
    case 'CONNECTED':
    case 'RUFLO_CONNECTED':
      return 'CONNECTED';
    case 'MOCKED':
      return 'AVAILABLE';
    case 'NOT_CONFIGURED':
    case 'AUTH_REQUIRED':
    case 'PUBLISHING_READY':
      return 'NOT_CONFIGURED';
    case 'DEGRADED':
      return 'DEGRADED';
    case 'ERROR':
    case 'UNAVAILABLE':
      return 'ERROR';
    default:
      return 'NOT_CONNECTED';
  }
}

export async function getIntegrationHealth(): Promise<IntegrationHealth[]> {
  const ai = describeAiCapability();
  const research = describeResearchProviderHealth();
  const ruflo = describeRufloIntegration();
  const rufloRuntime = await describeRufloRuntime().catch(() => ({ status: 'NOT_CONNECTED', detail: 'Ruflo runtime unavailable.', unmetRequirements: [] as string[] }));
  const publishing = describePublishingStatus();
  const vercel = describeVercelConfig();

  let databaseOk = false;
  try {
    await db.$queryRaw`SELECT 1`;
    databaseOk = true;
  } catch {
    databaseOk = false;
  }

  // Payments: Polar webhook ingestion exists (verified signature path). It is
  // CONFIGURED only when the webhook secret env is present; the secret value
  // is never read here beyond presence.
  const paymentsConfigured = Boolean(process.env.POLAR_WEBHOOK_SECRET?.trim());

  return [
    {
      name: 'AIAgent (external handoff sender)',
      state: 'NOT_CONFIGURED',
      detail:
        'HIGH-1 receiver endpoint exists (/api/handoff/receive). No producer deployment has delivered a '
        + 'verified authenticated request; no sender credential is bound to this deployment.',
      requiredForConnected: ['AIAgent adapter deployed', 'OPERATOR_CONTROL_TOKEN set server-side', 'First authenticated delivery observed'],
    },
    {
      name: 'Internal Agents (agency layer)',
      state: 'CONNECTED',
      detail: 'Agent registry, supervisor, permissions and health snapshots are part of this deployment.',
      requiredForConnected: [],
    },
    {
      name: 'Ruflo Orchestration',
      state: mapState(ruflo.status),
      detail: ruflo.detail,
      requiredForConnected: ruflo.status === 'RUFLO_CONNECTED' ? [] : ruflo.unmetRequirements,
    },
    {
      name: 'Ruflo Runtime',
      state: mapState(rufloRuntime.status),
      detail: rufloRuntime.detail,
      requiredForConnected: rufloRuntime.status === 'RUFLO_CONNECTED' ? [] : rufloRuntime.unmetRequirements,
    },
    {
      name: 'Harness',
      state: 'NOT_CONFIGURED',
      detail: 'Supervisor evaluations record harnessStatus NOT_CONNECTED; no harness adapter is configured.',
      requiredForConnected: ['Harness adapter configuration (none implemented)'],
    },
    {
      name: 'GitHub',
      state: 'NOT_CONNECTED',
      detail: 'No GitHub integration exists in this codebase (no token variable is read anywhere). Repository watcher is read-only and idle.',
      requiredForConnected: ['GITHUB read-only credential + verified API round-trip (adapter not yet implemented)'],
    },
    {
      name: 'AI Provider',
      state: mapState(ai.status === 'ERROR' ? 'UNAVAILABLE' : ai.status),
      detail: ai.detail,
      requiredForConnected: ai.status === 'LIVE' ? [] : ai.requiredToActivate,
    },
    {
      name: 'Payments (Polar)',
      state: 'NOT_CONFIGURED',
      detail: paymentsConfigured
        ? 'Webhook verification material present; LIVE requires a verified signed webhook round-trip.'
        : 'Webhook endpoint exists (/api/webhooks/polar) but verification material is absent; events would be refused.',
      requiredForConnected: paymentsConfigured ? ['Verified signed webhook round-trip'] : ['POLAR_WEBHOOK_SECRET (server-side)', 'Verified signed webhook round-trip'],
    },
    {
      name: 'Deployment (Vercel)',
      state: vercel.connected ? 'CONNECTED' : 'NOT_CONNECTED',
      detail: vercel.hint,
      requiredForConnected: vercel.connected ? [] : ['VERCEL_TOKEN (server-side)'],
    },
    {
      name: 'Research Provider',
      state: mapState(research.status),
      detail: research.hint || 'Research provider status recorded.',
      requiredForConnected: research.status === 'AVAILABLE' ? [] : ['RESEARCH_SEARCH_PROVIDER=searxng (no key) or tavily + TAVILY_API_KEY'],
    },
    {
      name: 'Publishing Provider',
      state: mapState(publishing.status),
      detail: publishing.note,
      requiredForConnected: publishing.status === 'AVAILABLE' ? [] : ['POLAR_ACCESS_TOKEN (server-side)', 'Verified provider round-trip'],
    },
    {
      name: 'Database',
      state: databaseOk ? 'CONNECTED' : 'ERROR',
      detail: databaseOk ? 'Database reachable.' : 'Database unreachable. Nothing was fabricated.',
      requiredForConnected: databaseOk ? [] : ['Restore DATABASE_URL connectivity'],
    },
    {
      name: 'Operator Control API',
      state: 'NOT_CONFIGURED',
      detail: operatorControlToken()
        ? 'Operator credential is configured server-side; control endpoints active for admin/operator callers.'
        : 'No operator credential configured; control endpoints fail closed (503).',
      requiredForConnected: operatorControlToken() ? [] : ['OPERATOR_CONTROL_TOKEN (server-side)'],
    },
  ];
}

// ---------------------------------------------------------------------------
// Phase 10.11 — GitHub / engineering watcher (bounded, read-only).
// ---------------------------------------------------------------------------

export type GitHubWatcherResult = GitHubWatcherView;

/**
 * Read-only repository intelligence. There is intentionally no GitHub client
 * and no token read: until a real, reviewed adapter exists the watcher must
 * report NOT_CONNECTED rather than approximate. No network calls, no mutation.
 */
export async function getGitHubWatcher(): Promise<GitHubWatcherResult> {
  return {
    state: 'NOT_CONNECTED',
    detail:
      'GitHub is not connected. No repository inspection has occurred; commits, PRs, CI runs and '
      + 'security signals are unknown (not zero). The watcher is read-only and creates nothing.',
    commits: [],
    pullRequests: [],
    ciRuns: [],
    governance: {
      readOnly: true,
      mutationPolicy:
        'inspect → detect → analyse → propose → (optional bounded branch/PR) → test → human approval → merge/deploy only under existing governance',
      humanApprovalRequiredFor: [
        'Security or authentication changes',
        'Payment or financial logic',
        'Destructive or production-infrastructure changes',
        'Any merge or deployment',
      ],
    },
  };
}
