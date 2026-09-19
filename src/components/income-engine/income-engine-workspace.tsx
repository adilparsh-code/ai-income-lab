'use client';

// Phase 7 — Income Engine workspace (client).
// Renders the deterministic loop state and drives single-stage advancement
// through the validated API. Every status shown is the engine's honest
// outcome: COMPLETED / BLOCKED / HUMAN_REVIEW / AWAITING_HUMAN_INPUT /
// DEGRADED / FAILED. Nothing is optimistically fabricated.

import { cn } from '@/lib/utils';
import {
  ArrowRight, Ban, CircleCheck, CircleDashed, Clock, Gauge,
  Lightbulb, RefreshCw, ShieldAlert, UserCheck,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useState } from 'react';
import type { IncomeLoopState, AdvanceOutcome, LoopLearning } from '@/lib/income-engine/engine';

export interface LoopCandidate {
  id: string;
  title: string;
  overallScore: number;
  status: string;
  halalStatus: string;
}

interface Props {
  candidates: LoopCandidate[];
  initialSelectedId: string | null;
  initialState: IncomeLoopState | null;
}

function stageTone(complete: boolean, isCurrent: boolean, blocker: boolean) {
  if (blocker) return 'border-red-300 bg-red-50 text-red-800';
  if (isCurrent) return 'border-indigo-400 bg-indigo-50 text-indigo-900 ring-2 ring-indigo-200';
  if (complete) return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  return 'border-border bg-card text-muted-foreground';
}

export function IncomeEngineWorkspace({ candidates, initialSelectedId, initialState }: Props) {
  const [selectedId, setSelectedId] = useState(initialSelectedId);
  const [state, setState] = useState(initialState);
  const [loading, setLoading] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastOutcome, setLastOutcome] = useState<AdvanceOutcome | null>(null);
  const [learnings, setLearnings] = useState<LoopLearning[] | null>(null);

  const selectOpportunity = useCallback(async (id: string) => {
    setSelectedId(id);
    setLoading(true);
    setError(null);
    setLastOutcome(null);
    setLearnings(null);
    try {
      const res = await fetch(`/api/income-loop/${id}`);
      const json = (await res.json()) as { ok: boolean; state?: IncomeLoopState; error?: string };
      if (json.ok && json.state) setState(json.state);
      else setError(json.error ?? 'Loop state unavailable.');
    } catch {
      setError('Failed to load loop state.');
    } finally {
      setLoading(false);
    }
  }, []);

  const advance = useCallback(async () => {
    if (!selectedId) return;
    setAdvancing(true);
    setError(null);
    try {
      const res = await fetch(`/api/income-loop/${selectedId}/advance`, { method: 'POST' });
      const json = (await res.json()) as { ok: boolean; outcome?: AdvanceOutcome; error?: string };
      if (json.outcome) setLastOutcome(json.outcome);
      else setError(json.error ?? 'Advance failed.');
      // Refresh state + learnings after every attempt.
      const stateRes = await fetch(`/api/income-loop/${selectedId}`);
      const stateJson = (await stateRes.json()) as { ok: boolean; state?: IncomeLoopState };
      if (stateJson.ok && stateJson.state) setState(stateJson.state);
      const learnRes = await fetch(`/api/income-loop/${selectedId}/learnings`);
      if (learnRes.ok) {
        const learnJson = (await learnRes.json()) as { ok: boolean; learnings?: LoopLearning[] };
        if (learnJson.ok && learnJson.learnings) setLearnings(learnJson.learnings);
      }
    } catch {
      setError('Advance request failed.');
    } finally {
      setAdvancing(false);
    }
  }, [selectedId]);

  const showLearnings = useCallback(async () => {
    if (!selectedId) return;
    try {
      const res = await fetch(`/api/income-loop/${selectedId}/learnings`);
      const json = (await res.json()) as { ok: boolean; learnings?: LoopLearning[] };
      if (json.ok && json.learnings) setLearnings(json.learnings);
    } catch {
      setError('Failed to load learnings.');
    }
  }, [selectedId]);

  if (candidates.length === 0) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800">
        No actionable opportunities. Create one to start the loop —{' '}
        <Link href="/opportunities/new" className="font-medium underline">find an opportunity</Link>.
      </div>
    );
  }

  const blocked = state?.halalGate.blocked ?? false;
  const reviewRequired = state?.halalGate.reviewRequired ?? false;

  return (
    <div className="space-y-6">
      {/* Opportunity selector */}
      <div className="flex flex-wrap gap-2">
        {candidates.map((c) => (
          <button
            key={c.id}
            onClick={() => selectOpportunity(c.id)}
            className={cn(
              'max-w-full truncate rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
              c.id === selectedId
                ? 'border-indigo-400 bg-indigo-50 text-indigo-900'
                : 'border-border bg-card text-muted-foreground hover:bg-muted/50',
            )}
          >
            {c.title} · {c.overallScore}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>
      )}

      {loading || !state ? (
        <div className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">Loading loop state…</div>
      ) : (
        <>
          {/* Header + gates */}
          <div className="rounded-xl border bg-card p-5 shadow-sm">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <Gauge className="h-4 w-4 text-indigo-600" />
                  <h2 className="text-sm font-semibold">Real Income Execution Loop</h2>
                  <span className={cn(
                    'rounded px-1.5 py-0.5 text-[10px] font-semibold',
                    state.dataMode === 'LIVE_DATA' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500',
                  )}>
                    {state.dataMode === 'LIVE_DATA' ? 'LIVE DATA' : 'NO DATA'}
                  </span>
                  {blocked && (
                    <span className="flex items-center gap-1 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">
                      <Ban className="h-3 w-3" /> NOT_ALLOWED
                    </span>
                  )}
                  {reviewRequired && (
                    <span className="flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                      <UserCheck className="h-3 w-3" /> REVIEW_REQUIRED
                    </span>
                  )}
                </div>
                <p className="truncate text-lg font-semibold">{state.opportunity?.title}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Score {state.opportunity?.overallScore} · status {state.opportunity?.status} · halal {state.opportunity?.halalStatus}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  onClick={advance}
                  disabled={advancing || blocked || reviewRequired}
                  className={cn(
                    'inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium shadow-sm transition-colors',
                    blocked || reviewRequired
                      ? 'cursor-not-allowed bg-slate-100 text-slate-400'
                      : 'bg-indigo-600 text-white hover:bg-indigo-700',
                  )}
                >
                  {advancing ? <RefreshCw className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                  {advancing ? 'Advancing…' : `Advance ${state.currentStage ?? 'loop'}`}
                </button>
                <button
                  onClick={showLearnings}
                  className="inline-flex items-center gap-2 rounded-lg border border-indigo-200 bg-white px-3 py-2.5 text-sm font-medium text-indigo-700 hover:bg-indigo-50"
                >
                  <Lightbulb className="h-4 w-4" /> Learnings
                </button>
              </div>
            </div>

            {state.advanceBlocker && (
              <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                {state.advanceBlocker}
              </div>
            )}
            {lastOutcome && (
              <div className={cn(
                'mt-3 rounded-lg border p-3 text-xs',
                lastOutcome.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-amber-300 bg-amber-50 text-amber-900',
              )}>
                <span className="font-semibold">{lastOutcome.status}</span> — {lastOutcome.message}
                {lastOutcome.jobId && <> · job <span className="font-mono">{lastOutcome.jobId.slice(0, 12)}</span></>}
                {lastOutcome.deduplicated && <> (idempotent)</>}
              </div>
            )}
          </div>

          {/* Loop rail */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            {state.stages.map((s) => {
              const isCurrent = s.stage === state.currentStage;
              const isBlocker = isCurrent && !!state.advanceBlocker;
              return (
                <div key={s.stage} className={cn('rounded-lg border p-3', stageTone(s.complete, isCurrent, isBlocker))}>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold tracking-wide">{s.stage}</span>
                    {s.complete ? (
                      <CircleCheck className="h-3.5 w-3.5" />
                    ) : isCurrent ? (
                      <Clock className="h-3.5 w-3.5" />
                    ) : (
                      <CircleDashed className="h-3.5 w-3.5 opacity-50" />
                    )}
                  </div>
                  <p className="mt-1.5 text-[11px] leading-snug opacity-80">{s.evidence}</p>
                  <p className="mt-1 text-[10px] font-medium opacity-60">
                    {s.evidenceType === 'VERIFIED_DATA' ? 'VERIFIED' : s.evidenceType === 'AI_INFERENCE' ? 'AI INFERENCE' : '—'}
                  </p>
                </div>
              );
            })}
          </div>

          {/* Metrics + learnings */}
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border bg-card p-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recorded metrics (real rows only)</h3>
              <div className="grid grid-cols-3 gap-2 text-center">
                {[
                  ['Experiments', state.metrics.experiments],
                  ['Positive', state.metrics.positiveDecisions],
                  ['Products', state.metrics.products],
                  ['Published', state.metrics.publishedProducts],
                  ['Traffic', state.metrics.trafficEvents],
                  ['Revenue rows', state.metrics.revenueRecords],
                ].map(([label, value]) => (
                  <div key={label as string} className="rounded-lg bg-muted/40 p-2">
                    <p className="text-base font-semibold">{value as number}</p>
                    <p className="text-[10px] text-muted-foreground">{label as string}</p>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">Net revenue: ${state.metrics.netRevenue.toFixed(2)} · learnings on file: {state.metrics.learningsRecorded}</p>
            </div>
            <div className="rounded-xl border bg-card p-4">
              <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Lightbulb className="h-3.5 w-3.5" /> Loop learnings (deterministic, from recorded outcomes)
              </h3>
              {learnings === null ? (
                <p className="text-xs text-muted-foreground">Click “Learnings” to derive the current bottleneck analysis.</p>
              ) : learnings.length === 0 ? (
                <p className="text-xs text-muted-foreground">No learnings derivable yet — record real outcome data first.</p>
              ) : (
                <ul className="space-y-1.5">
                  {learnings.map((l) => (
                    <li key={l.learning.slice(0, 40)} className="text-xs leading-snug">
                      <span className="mr-1 rounded bg-indigo-100 px-1 py-0.5 text-[10px] font-semibold text-indigo-700">{l.evidenceType}</span>
                      {l.learning}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <p className="text-[11px] text-muted-foreground">
            Stages execute through the existing job runner (halal gates, idempotency, bounded retries). PUBLISH is
            human-gated: without an approval token the publishing boundary refuses and the refusal is recorded. Traffic
            and revenue enter only via real ingestion endpoints. State as of {new Date(state.generatedAt).toLocaleTimeString()}.
          </p>
        </>
      )}
    </div>
  );
}
