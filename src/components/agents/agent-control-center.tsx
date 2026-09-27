'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/shared/page-header';
import { Bot, CheckCircle2, XCircle, PauseCircle, ShieldAlert, RefreshCw, Activity, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Roster agents with existing detail pages (/agents/<id>). */
const DETAIL_LINKS = new Set(['research', 'validation', 'product', 'analytics', 'business-manager']);

type RosterEntry = {
  agentId: string;
  role: string;
  status: 'OFFLINE' | 'READY' | 'RUNNING' | 'WAITING' | 'BLOCKED' | 'FAILED' | 'PAUSED' | 'DEGRADED';
  health: string;
  healthReasons: string[];
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  successCount: number;
  failureCount: number;
  budgetLimitUsd: number;
  allowedTools: string[];
  requiresApproval: boolean;
  evidenceRequirement: string;
};

type ContractEntry = {
  agentId: string;
  role: string;
  mission: string;
  allowedTools: string[];
  allowedStages: string[];
  budgetLimitUsd: number;
  timeoutMs: number;
  maxRetries: number;
  requiresApproval: boolean;
  humanApprovalCategories: string[];
  stopConditions: string[];
  evidenceRequirement: string;
};

type ReviewEntry = {
  id: string;
  category: string;
  title: string;
  detail: string;
  status: string;
  requestedBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
};

type ControlState = {
  paused: boolean;
  pauseReason: string | null;
  pausedBy: string | null;
  pausedAt: string | null;
};

const STATUS_TONE: Record<string, string> = {
  OFFLINE: 'bg-slate-100 text-slate-600',
  READY: 'bg-emerald-100 text-emerald-800',
  RUNNING: 'bg-blue-100 text-blue-800',
  WAITING: 'bg-amber-100 text-amber-800',
  BLOCKED: 'bg-red-100 text-red-800',
  FAILED: 'bg-red-100 text-red-800',
  PAUSED: 'bg-slate-200 text-slate-700',
  DEGRADED: 'bg-orange-100 text-orange-800',
};

function StatusChip({ status }: { status: string }) {
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide', STATUS_TONE[status] ?? 'bg-slate-100 text-slate-600')}>
      {status}
    </span>
  );
}

export function AgentControlCenter() {
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [contracts, setContracts] = useState<Record<string, ContractEntry>>({});
  const [reviews, setReviews] = useState<ReviewEntry[]>([]);
  const [control, setControl] = useState<ControlState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [rosterRes, reviewsRes, controlRes] = await Promise.all([
        fetch('/api/agency/roster'),
        fetch('/api/agency/reviews?status=PENDING'),
        fetch('/api/agency/control'),
      ]);
      if (rosterRes.status === 401 || controlRes.status === 401 || reviewsRes.status === 401) {
        setError('Admin session required. Sign in at /login.');
        return;
      }
      const rosterJson = (await rosterRes.json()) as { ok: boolean; roster?: RosterEntry[]; contracts?: ContractEntry[]; error?: string };
      const reviewsJson = (await reviewsRes.json()) as { ok: boolean; reviews?: ReviewEntry[] };
      const controlJson = (await controlRes.json()) as { ok: boolean; control?: ControlState };
      if (rosterJson.ok && rosterJson.roster) {
        setRoster(rosterJson.roster);
        setContracts(Object.fromEntries((rosterJson.contracts ?? []).map((c) => [c.agentId, c])));
      } else {
        setError(rosterJson.error ?? 'Roster unavailable.');
      }
      if (reviewsJson.ok && reviewsJson.reviews) setReviews(reviewsJson.reviews);
      if (controlJson.ok && controlJson.control) setControl(controlJson.control);
    } catch {
      setError('The control center could not be reached.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Initial load in an async callback (not synchronously in the effect body).
    void (async () => {
      await load();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function decide(id: string, decision: 'APPROVE' | 'REJECT' | 'PAUSE' | 'RETRY') {
    setBusy(true);
    try {
      const res = await fetch('/api/agency/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, decision }),
      });
      if (res.ok) void load();
      else setError('Decision could not be recorded.');
    } catch {
      setError('Decision could not be recorded.');
    } finally {
      setBusy(false);
    }
  }

  async function togglePause() {
    if (!control) return;
    setBusy(true);
    try {
      const res = await fetch('/api/agency/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: !control.paused, reason: control.paused ? undefined : 'Paused from the Agent Control Center.' }),
      });
      const json = (await res.json()) as { ok: boolean; control?: ControlState; error?: string };
      if (json.ok && json.control) setControl(json.control);
      else setError(json.error ?? 'Control update failed.');
    } catch {
      setError('Control update failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <PageHeader
        title="Agent Control Center"
        description="Single-admin supervision of the 13-agent roster. Statuses come from real run records — never fabricated LIVE badges."
      />

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      )}

      {/* Global control */}
      <div className="rounded-xl border bg-card p-4 shadow-sm flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Activity className="h-5 w-5 text-muted-foreground" />
          <div>
            <h2 className="text-sm font-semibold">Agency autonomy</h2>
            <p className="text-xs text-muted-foreground">
              {control
                ? control.paused
                  ? `PAUSED — ${control.pauseReason ?? 'no reason recorded'}${control.pausedBy ? ` (by ${control.pausedBy})` : ''}`
                  : 'Running — supervised dispatch is allowed.'
                : 'Loading control state…'}
            </p>
          </div>
        </div>
        <button
          onClick={togglePause}
          disabled={busy || !control}
          className={cn(
            'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50',
            control?.paused
              ? 'bg-emerald-600 text-white hover:bg-emerald-500'
              : 'bg-red-600 text-white hover:bg-red-500',
          )}
        >
          {control?.paused ? <CheckCircle2 className="h-4 w-4" /> : <PauseCircle className="h-4 w-4" />}
          {control?.paused ? 'Resume agency' : 'Pause agency'}
        </button>
      </div>

      {/* Human review queue */}
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-amber-600" />
            <h2 className="text-sm font-semibold">Human review queue ({reviews.length} pending)</h2>
          </div>
          <button onClick={load} disabled={busy} className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50">
            <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
            Refresh
          </button>
        </div>
        <div className="divide-y">
          {reviews.length === 0 && (
            <p className="px-4 py-6 text-center text-xs text-muted-foreground">No pending reviews. Decisions will appear here when agents request human approval.</p>
          )}
          {reviews.map((review) => (
            <div key={review.id} className="px-4 py-3 flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{review.title}</p>
                <p className="text-xs text-muted-foreground">
                  {review.category} · requested by {review.requestedBy} · {new Date(review.createdAt).toLocaleString()}
                </p>
                {review.detail && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{review.detail}</p>}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => decide(review.id, 'APPROVE')}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" /> Approve
                </button>
                <button
                  onClick={() => decide(review.id, 'REJECT')}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded-md bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-50"
                >
                  <XCircle className="h-3.5 w-3.5" /> Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Roster */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {roster.map((agent) => {
          const contract = contracts[agent.agentId];
          return (
            <div key={agent.agentId} className="rounded-xl border bg-card p-5 shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Bot className="h-5 w-5 text-muted-foreground" />
                  <h3 className="text-sm font-semibold">{agent.role}</h3>
                </div>
                <div className="flex items-center gap-1.5">
                  {DETAIL_LINKS.has(agent.agentId) && (
                    <Link href={`/agents/${agent.agentId}`} className="text-muted-foreground hover:text-foreground" aria-label={`${agent.role} details`}>
                      <ArrowRight className="h-4 w-4" />
                    </Link>
                  )}
                  <StatusChip status={agent.status} />
                </div>
              </div>

              {contract && <p className="text-xs text-muted-foreground line-clamp-3">{contract.mission}</p>}

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="text-muted-foreground">Health:</span>{' '}
                  <span className={cn('font-semibold', agent.health === 'HEALTHY' ? 'text-emerald-600' : agent.health === 'UNKNOWN' ? 'text-slate-500' : 'text-orange-600')}>
                    {agent.health}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Budget cap:</span>{' '}
                  <span className="font-semibold">${agent.budgetLimitUsd.toFixed(2)}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Successes:</span> <span className="font-semibold">{agent.successCount}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Failures:</span> <span className="font-semibold">{agent.failureCount}</span>
                </div>
              </div>

              {agent.healthReasons.length > 0 && (
                <p className="text-[10px] text-muted-foreground leading-snug">{agent.healthReasons[0]}</p>
              )}

              <div className="pt-2 border-t space-y-1.5">
                <div>
                  <span className="text-[10px] font-medium text-muted-foreground">Allowed tools ({agent.allowedTools.length}):</span>
                  <p className="text-[10px] text-muted-foreground truncate">{agent.allowedTools.join(', ')}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground">Evidence policy:</span>
                  <span className="rounded bg-slate-100 px-1 py-0.5 text-[10px] font-medium text-slate-700">{agent.evidenceRequirement}</span>
                  {agent.requiresApproval && (
                    <span className="rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium text-amber-800">APPROVAL REQUIRED</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {roster.length === 0 && !error && (
        <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
          {busy ? 'Loading roster…' : 'No roster data available.'}
        </div>
      )}
    </div>
  );
}
