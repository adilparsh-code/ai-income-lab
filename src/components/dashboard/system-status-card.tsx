'use client';

// Phase 5 — System Status card (dashboard).
// Renders ONLY truthful statuses: LIVE / MOCKED / PLANNED / UNAVAILABLE /
// DEGRADED / HUMAN_REVIEW / BLOCKED. Every value comes from server-computed
// state; nothing is fabricated here.

import { cn } from '@/lib/utils';
import { Bot, Globe, ShieldCheck, Workflow } from 'lucide-react';

export interface SystemStatusData {
  research: {
    providerId: string | null;
    status: 'AVAILABLE' | 'RESEARCH_UNAVAILABLE' | 'DEGRADED';
    hint: string;
    verifiedEvidenceCount: number;
    discoveryCount: number;
  };
  publishing: {
    status: 'AVAILABLE' | 'PUBLISHING_UNAVAILABLE' | 'NOT_CONNECTED';
    note: string;
  };
  ruflo: {
    status: 'RUFLO_READY' | 'NOT_CONNECTED';
    workflowCount: number;
    lastWorkflowStatus: string | null;
  };
  growth: {
    lastAction: string | null;
    dataStatus: string | null;
  };
}

function StatusBadge({ label, tone }: { label: string; tone: 'good' | 'warn' | 'muted' }) {
  const toneClass = tone === 'good'
    ? 'bg-emerald-100 text-emerald-700'
    : tone === 'warn'
      ? 'bg-amber-100 text-amber-700'
      : 'bg-slate-100 text-slate-500';
  return <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold', toneClass)}>{label}</span>;
}

function Tile({
  icon,
  title,
  badges,
  lines,
}: {
  icon: React.ReactNode;
  title: string;
  badges: { label: string; tone: 'good' | 'warn' | 'muted' }[];
  lines: string[];
}) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-muted-foreground">{icon}</span>
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {badges.map((b) => <StatusBadge key={b.label} label={b.label} tone={b.tone} />)}
      </div>
      <div className="space-y-1">
        {lines.map((line) => (
          <p key={line} className="text-xs leading-snug text-muted-foreground">{line}</p>
        ))}
      </div>
    </div>
  );
}

export function SystemStatusCard({ data }: { data: SystemStatusData }) {
  const researchTone = data.research.status === 'AVAILABLE' ? 'good' : 'warn';
  const rufloTone = data.ruflo.status === 'RUFLO_READY' ? 'muted' : 'muted';
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Tile
        icon={<Globe className="h-4 w-4" />}
        title="Real Research"
        badges={[
          { label: data.research.status === 'AVAILABLE' ? 'REAL RESEARCH' : 'RESEARCH_UNAVAILABLE', tone: researchTone },
          ...(data.research.verifiedEvidenceCount > 0 ? [{ label: `${data.research.verifiedEvidenceCount} VERIFIED`, tone: 'good' as const }] : []),
          ...(data.research.discoveryCount > 0 ? [{ label: `${data.research.discoveryCount} DISCOVERY`, tone: 'muted' as const }] : []),
        ]}
        lines={[
          data.research.providerId
            ? `Provider: ${data.research.providerId}`
            : 'No external provider configured — nothing is fetched, nothing fabricated.',
          data.research.hint.length > 0 ? data.research.hint : 'Evidence keeps strict provenance: SEARCH_DISCOVERY snippets are never VERIFIED_DATA.',
        ]}
      />
      <Tile
        icon={<Bot className="h-4 w-4" />}
        title="Publishing"
        badges={[{ label: data.publishing.status, tone: 'warn' }]}
        lines={[data.publishing.note]}
      />
      <Tile
        icon={<Workflow className="h-4 w-4" />}
        title="Ruflo Orchestration"
        badges={[{ label: data.ruflo.status === 'RUFLO_READY' ? 'RUFLO READY · NOT CONNECTED' : 'NOT CONNECTED', tone: rufloTone }]}
        lines={[
          `Workflow runs recorded: ${data.ruflo.workflowCount}.`,
          data.ruflo.lastWorkflowStatus ? `Last workflow: ${data.ruflo.lastWorkflowStatus}.` : 'No workflow executed yet.',
          'The contract (workflows + job runner + agents) is ready for an external orchestrator; nothing runs autonomously.',
        ]}
      />
      <Tile
        icon={<ShieldCheck className="h-4 w-4" />}
        title="Growth Loop"
        badges={[...(data.growth.lastAction ? [{ label: data.growth.lastAction, tone: 'good' as const }] : [{ label: 'NO DATA', tone: 'muted' as const }])]}
        lines={[
          data.growth.dataStatus
            ? `Latest growth recommendation basis: ${data.growth.dataStatus}.`
            : 'Growth engine activates once real revenue/experiment records exist.',
          'Revenue → Analytics → Growth Engine → Business Manager → Next Best Action. No revenue is ever guaranteed.',
        ]}
      />
    </div>
  );
}
