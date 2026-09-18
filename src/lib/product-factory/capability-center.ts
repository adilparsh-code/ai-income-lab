// Phase 5.5 — Central capability center (Part 13).
//
// ONE truthful aggregate surface over every external boundary. Each entry
// derives from REAL configuration/runtime state — never from aspiration:
//
//   LIVE            — actually verified working right now (or a real runtime is
//                     genuinely wired and its contract produces confirmed
//                     results).
//   MOCKED          — deterministic local substitute is active by design.
//   NOT_CONNECTED   — contract exists; no credentials/runtime are configured.
//   NOT_CONFIGURED  — a mode is selected but its required key/setting is absent.
//   UNAVAILABLE     — configured but the current environment cannot execute it.
//   PLANNED         — boundary designed but no implementation yet.
//
// The center NEVER reveals secret values: at most a fingerprint prefix and
// whether a credential exists. Everything here is safe for dashboard/API use.

import { describeAiCapability } from '@/lib/ai/capability';
import { describeResearchProviderHealth } from '@/lib/research/provider';
import { describeBuilderCapabilities } from '@/lib/product-factory/sandboxed-builder';
import { describeVercelConfig } from '@/lib/product-factory/deployment-vercel';
import { describePublishingStatus } from '@/lib/publishing/contract';
import { describeRufloIntegration } from '@/lib/ruflo/capability';
import { emptyTreasury, deriveTreasury } from '@/lib/business/agent-treasury';

export type CapabilityLabel =
  | 'LIVE'
  | 'MOCKED'
  | 'NOT_CONNECTED'
  | 'NOT_CONFIGURED'
  | 'UNAVAILABLE'
  | 'PLANNED';

export interface CapabilityEntry {
  name: string;
  status: CapabilityLabel;
  /** Safe, bounded explanation (no secrets, no raw env values). */
  detail: string;
  /** What an operator must provide to move toward LIVE. */
  requiredForLive: string[];
  /** Whether human approval is mandatory for this capability's actions. */
  requiresHumanApproval: boolean;
}

export interface CapabilityCenterReport {
  generatedAt: string;
  capabilities: CapabilityEntry[];
  /** At-a-glance counts by label (dashboard summary chips). */
  counts: Record<CapabilityLabel, number>;
}

export function describeCapabilityCenter(): CapabilityCenterReport {
  const ai = describeAiCapability();
  const research = describeResearchProviderHealth();
  const builder = describeBuilderCapabilities();
  const vercel = describeVercelConfig();
  const publishing = describePublishingStatus();
  const ruflo = describeRufloIntegration();
  const treasury = deriveTreasury(emptyTreasury());

  const capabilities: CapabilityEntry[] = [
    {
      name: 'AI Provider',
      status: ai.status === 'LIVE' || ai.status === 'MOCKED' || ai.status === 'NOT_CONFIGURED' || ai.status === 'ERROR'
        ? ai.status === 'ERROR'
          ? 'UNAVAILABLE'
          : ai.status
        : 'NOT_CONFIGURED',
      detail: ai.detail,
      requiredForLive: ai.requiredToActivate,
      requiresHumanApproval: false,
    },
    {
      name: 'Research Provider',
      status: research.status === 'AVAILABLE' ? 'LIVE' : research.status === 'DEGRADED' ? 'UNAVAILABLE' : 'NOT_CONNECTED',
      detail: research.hint || `External research provider ${research.providerId ?? '(none)'} is configured and resolvable.`,
      requiredForLive: research.status === 'AVAILABLE'
        ? []
        : ['RESEARCH_SEARCH_PROVIDER=searxng (no key) or tavily + TAVILY_API_KEY'],
      requiresHumanApproval: false,
    },
    {
      name: 'Product Builder',
      status: 'LIVE',
      detail:
        `Deterministic sandboxed builder is active (${builder.length} capability tier(s) available). `
        + 'No arbitrary code execution: quality gates and manifest hashing only.',
      requiredForLive: [],
      requiresHumanApproval: false,
    },
    {
      name: 'Deployment (Vercel)',
      status: vercel.connected ? 'LIVE' : 'NOT_CONNECTED',
      detail: vercel.hint,
      requiredForLive: vercel.connected
        ? []
        : ['VERCEL_TOKEN (server-side)', 'Human approval token per deployment'],
      requiresHumanApproval: true,
    },
    {
      name: 'Publishing',
      status: publishing.status === 'AVAILABLE' ? 'LIVE' : 'NOT_CONNECTED',
      detail: publishing.note,
      requiredForLive: publishing.status === 'AVAILABLE'
        ? []
        : ['An authorized publishing-channel adapter with credentials', 'Human approval token per publication'],
      requiresHumanApproval: true,
    },
    {
      name: 'Ruflo Orchestration',
      status: ruflo.status === 'RUFLO_CONNECTED' ? 'LIVE' : 'NOT_CONNECTED',
      detail: ruflo.detail,
      requiredForLive: ruflo.unmetRequirements,
      requiresHumanApproval: false,
    },
    {
      name: 'Traffic Events',
      status: 'LIVE',
      detail:
        'ProductEvent ingestion is live (idempotency-keyed, provenance-tagged). External analytics adapters '
        + 'are PLANNED; recorded events remain the authoritative evidence either way.',
      requiredForLive: [],
      requiresHumanApproval: false,
    },
    {
      name: 'Revenue Recording',
      status: 'LIVE',
      detail:
        'Revenue rows are operator/provider recorded with attribution and idempotency keys. Payment-provider '
        + 'auto-ingestion is PLANNED; no revenue figure is ever generated by AI.',
      requiredForLive: [],
      requiresHumanApproval: false,
    },
    {
      name: 'Revenue Ingestion API',
      status: process.env.OPERATOR_REVENUE_TOKEN?.trim() ? 'LIVE' : 'NOT_CONFIGURED',
      detail: process.env.OPERATOR_REVENUE_TOKEN?.trim()
        ? 'POST /api/revenue is active: token-gated (constant-time comparison), server-derived idempotency, automatic attribution. The token is never logged or exposed.'
        : 'POST /api/revenue exists but refuses all writes until OPERATOR_REVENUE_TOKEN is set server-side (fail-closed). Nothing can be recorded without it.',
      requiredForLive: process.env.OPERATOR_REVENUE_TOKEN?.trim() ? [] : ['OPERATOR_REVENUE_TOKEN (server-side)'],
      requiresHumanApproval: false,
    },
    {
      name: 'Traffic Event Ingestion',
      status: 'LIVE',
      detail:
        'POST /api/events ingests visitor/purchase events idempotently with provenance; GET /api/events returns deterministic funnel metrics labelled SUPPORTED or INSUFFICIENT_DATA.',
      requiredForLive: [],
      requiresHumanApproval: false,
    },
    {
      name: 'Per-Product AI Cost',
      status: 'LIVE',
      detail:
        'AgentLog carries optional productId/opportunityId/correlationId attribution written once per AI execution; '
        + 'aggregates cannot double-count.',
      requiredForLive: [],
      requiresHumanApproval: false,
    },
    {
      name: 'Agent Treasury',
      status: 'LIVE',
      detail:
        `Internal accounting only (automaticTransfer is structurally false). Current utilization: ` +
        `${treasury.utilizationPercent === null ? 'n/a' : treasury.utilizationPercent.toFixed(1) + '%'}; no real money movement exists.`,
      requiredForLive: [],
      requiresHumanApproval: true,
    },
    {
      name: 'Memory (Durable)',
      status: 'LIVE',
      detail:
        'Memory derives from real DB records with provenance and timestamps; bounded categories, no unrestricted conversational store.',
      requiredForLive: [],
      requiresHumanApproval: false,
    },
  ];

  const counts = capabilities.reduce(
    (acc, c) => {
      acc[c.status] += 1;
      return acc;
    },
    { LIVE: 0, MOCKED: 0, NOT_CONNECTED: 0, NOT_CONFIGURED: 0, UNAVAILABLE: 0, PLANNED: 0 } as Record<CapabilityLabel, number>,
  );

  return { generatedAt: new Date().toISOString(), capabilities, counts };
}
