'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Circle,
  Clock,
  FlaskConical,
  Loader2,
  Play,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { executePipelineRun } from '@/actions/pipeline';
import type { PipelineOpportunityOption, PipelineRunSummary } from '@/actions/pipeline';
import type { PipelineRunResult } from '@/lib/ruflo/orchestrator';
import {
  PIPELINE_ORDER,
  PIPELINE_STAGE_META,
  type PipelineStage,
} from '@/lib/ruflo/pipeline-logic';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Presentation helpers (client-safe: pure, local to this component)
// ---------------------------------------------------------------------------

type StatusKey = 'COMPLETED' | 'PARTIAL' | 'BLOCKED' | 'HUMAN_REVIEW' | 'FAILED';

const STATUS_STYLES: Record<StatusKey, { banner: string; chip: string; label: string }> = {
  COMPLETED: {
    banner: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    chip: 'bg-emerald-100 text-emerald-700',
    label: 'Completed',
  },
  PARTIAL: {
    banner: 'border-amber-200 bg-amber-50 text-amber-900',
    chip: 'bg-amber-100 text-amber-700',
    label: 'Partial — failed safely',
  },
  BLOCKED: {
    banner: 'border-red-200 bg-red-50 text-red-900',
    chip: 'bg-red-100 text-red-700',
    label: 'Blocked (NOT_ALLOWED)',
  },
  HUMAN_REVIEW: {
    banner: 'border-indigo-200 bg-indigo-50 text-indigo-900',
    chip: 'bg-indigo-100 text-indigo-700',
    label: 'Human review required',
  },
  FAILED: {
    banner: 'border-red-200 bg-red-50 text-red-900',
    chip: 'bg-red-100 text-red-700',
    label: 'Failed',
  },
};

const STAGE_STATE_STYLES: Record<string, string> = {
  SUCCEEDED: 'bg-emerald-100 text-emerald-700',
  FAILED: 'bg-red-100 text-red-700',
  SKIPPED: 'bg-amber-100 text-amber-700',
  PENDING: 'bg-slate-50 text-slate-400 border border-slate-200',
};

function statusKey(value: string): StatusKey {
  return (['COMPLETED', 'PARTIAL', 'BLOCKED', 'HUMAN_REVIEW', 'FAILED'] as const).includes(
    value as StatusKey,
  )
    ? (value as StatusKey)
    : 'FAILED';
}

function formatCost(usd: number): string {
  return usd > 0 ? `$${usd.toFixed(6)}` : '$0';
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function ProgressRail({ run }: { run: PipelineRunResult }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {run.progress.map((p) => (
        <span
          key={p.stage}
          title={p.note ?? PIPELINE_STAGE_META[p.stage].description}
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium',
            STAGE_STATE_STYLES[p.state] ?? STAGE_STATE_STYLES.PENDING,
          )}
        >
          {p.state === 'SUCCEEDED' ? (
            <CheckCircle2 className="h-3.5 w-3.5" />
          ) : p.state === 'FAILED' ? (
            <XCircle className="h-3.5 w-3.5" />
          ) : p.state === 'SKIPPED' ? (
            <AlertCircle className="h-3.5 w-3.5" />
          ) : (
            <Circle className="h-3.5 w-3.5" />
          )}
          {p.label}
        </span>
      ))}
    </div>
  );
}

function FindingList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
        {title}
      </h4>
      <ul className="space-y-1.5">
        {items.map((item, i) => (
          <li key={`${title}-${i}`} className="flex items-start gap-2 text-sm">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
            <span className="text-foreground/90">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ExperimentPlanCard({ run }: { run: PipelineRunResult }) {
  if (run.experimentPlan.length === 0) return null;
  return (
    <div className="rounded-lg border bg-muted/30 p-4">
      <div className="mb-3 flex items-center gap-2">
        <FlaskConical className="h-4 w-4 text-indigo-600" />
        <h4 className="text-sm font-semibold">Prioritized experiment plan</h4>
        <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-700">
          human-gated
        </span>
      </div>
      <div className="space-y-3">
        {run.experimentPlan.map((exp) => (
          <div key={exp.id} className="rounded-md border bg-card p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{exp.name}</span>
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                {exp.method}
              </span>
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                effort: {exp.effort}
              </span>
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                priority: {exp.priority}
              </span>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">{exp.hypothesis}</p>
            {(exp.successThreshold !== null || exp.failureThreshold !== null) && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {exp.successThreshold !== null && <>success ≥ {exp.successThreshold} </>}
                {exp.failureThreshold !== null && <>· failure &lt; {exp.failureThreshold}</>}
                {exp.metric ? <> (metric: {exp.metric})</> : null}
              </p>
            )}
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground">
        Creating or running these experiments, spending money, and publishing are never
        executed automatically — record outcomes yourself on the Experiments page.
      </p>
    </div>
  );
}

function RunResultPanel({ run }: { run: PipelineRunResult }) {
  const key = statusKey(run.status);
  const style = STATUS_STYLES[key];
  const provenanceCounts = Object.entries(run.findings.provenanceCounts);
  const aiTotals = run.findings.aiTotals;

  return (
    <div className="space-y-4">
      {/* Status banner */}
      <div className={cn('rounded-xl border p-4', style.banner)} role="status">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', style.chip)}>
            {style.label}
          </span>
          <span className="text-xs opacity-80">
            lifecycle: {run.lifecycleStage} · provenance: {run.provenance} ·{' '}
            {formatDuration(run.executionTime)}
          </span>
        </div>
        <p className="mt-2 text-sm">{run.reasoning}</p>
        <p className="mt-1 text-xs opacity-75">{run.lifecycleRationale}</p>
      </div>

      {/* Stage progress */}
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          Stage progress
        </h4>
        <ProgressRail run={run} />
      </div>

      {/* Human review callout */}
      {run.humanReviewRequired && (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-900">
          <strong>Human review required.</strong> No autonomous execution happened for the
          gated parts of this workflow. Review the outputs before acting on them.
        </div>
      )}

      {/* Experiment plan */}
      <ExperimentPlanCard run={run} />

      {/* Findings grid */}
      <div className="grid gap-4 sm:grid-cols-2">
        <FindingList title="Risks" items={run.findings.risks} />
        <FindingList title="Assumptions" items={run.findings.assumptions} />
        <FindingList title="Missing evidence" items={run.findings.missingEvidence} />
        <FindingList title="Next actions" items={run.findings.nextActions} />
      </div>

      {/* Provenance + AI usage footer */}
      <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold uppercase tracking-wide">Provenance:</span>
          {provenanceCounts.length === 0 ? (
            <span>no evidence items produced</span>
          ) : (
            provenanceCounts.map(([type, count]) => (
              <span
                key={type}
                className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600"
              >
                {type}: {count}
              </span>
            ))
          )}
        </div>
        {aiTotals.liveSteps > 0 && (
          <p className="mt-1.5">
            AI usage: {aiTotals.liveSteps} live step(s), {aiTotals.inputTokens} in /{' '}
            {aiTotals.outputTokens} out tokens, estimated cost {formatCost(aiTotals.estimatedCostUsd)}{' '}
            (estimate, not billing data).
          </p>
        )}
        {aiTotals.fallbackSteps > 0 && (
          <p className="mt-1.5">
            {aiTotals.fallbackSteps} step(s) used the deterministic fallback after AI failure —
            clearly marked MOCKED, never presented as live output.
          </p>
        )}
      </div>
    </div>
  );
}

function EmptyResults() {
  return (
    <div className="rounded-xl border-2 border-dashed border-muted-foreground/25 bg-muted/30 p-8 text-center">
      <Sparkles className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" />
      <h3 className="mb-1 text-lg font-semibold">No run yet</h3>
      <p className="mx-auto mb-2 max-w-md text-sm text-muted-foreground">
        Select an opportunity (or enter a custom objective) and run the bounded pipeline:
        research → validation → product → experiment plan → tracking.
      </p>
      <p className="mx-auto max-w-md text-xs text-muted-foreground">
        Halal gates run before every stage. NOT_ALLOWED hard-blocks the run; REVIEW_REQUIRED
        pauses it for human review. Publishing, spending, and pricing stay human-gated.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main workspace
// ---------------------------------------------------------------------------

interface PipelineWorkspaceProps {
  opportunities: PipelineOpportunityOption[];
  recentRuns: PipelineRunSummary[];
}

export function PipelineWorkspace({ opportunities, recentRuns }: PipelineWorkspaceProps) {
  const [selectedId, setSelectedId] = useState('');
  const [objective, setObjective] = useState('');
  const [selectedStages, setSelectedStages] = useState<PipelineStage[]>([...PIPELINE_ORDER]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PipelineRunResult | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const allStagesSelected = selectedStages.length === PIPELINE_ORDER.length;
  const selectedOpportunity = useMemo(
    () => opportunities.find((o) => o.id === selectedId) ?? null,
    [opportunities, selectedId],
  );

  const toggleStage = (stage: PipelineStage) => {
    setSelectedStages((prev) =>
      prev.includes(stage) ? prev.filter((s) => s !== stage) : [...prev, stage],
    );
  };

  const runPipeline = async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    setSubmitted(true);
    try {
      const response = await executePipelineRun({
        ...(selectedId ? { opportunityId: selectedId } : {}),
        objective,
        ...(allStagesSelected ? {} : { stages: selectedStages }),
      });
      if (response.ok) {
        setResult(response.run);
      } else {
        setError(response.error);
      }
    } catch {
      setError('The pipeline could not be executed. Check your connection and try again.');
    } finally {
      setRunning(false);
    }
  };

  const canRun = !running && (selectedId ? true : objective.trim().length > 0);
  const showObjectiveHint = submitted && !selectedId && objective.trim().length === 0;

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {/* Left column: run configuration */}
      <div className="space-y-6 lg:col-span-1">
        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Run the pipeline
          </h3>

          {/* Opportunity selector */}
          <label htmlFor="pipeline-opportunity" className="mb-1.5 block text-sm font-medium">
            Opportunity
          </label>
          {opportunities.length === 0 ? (
            <div className="rounded-lg border border-dashed border-muted-foreground/25 bg-muted/30 p-3 text-center text-sm text-muted-foreground">
              No opportunities yet.
              <Link
                href="/opportunities/new"
                className="ml-1 font-medium text-indigo-600 hover:underline"
              >
                Add your first opportunity
              </Link>{' '}
              or run with a custom objective below.
            </div>
          ) : (
            <select
              id="pipeline-opportunity"
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              disabled={running}
            >
              <option value="">— Custom objective (no opportunity) —</option>
              {opportunities.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.halalStatus === 'NOT_ALLOWED' ? '⛔ ' : ''}
                  {o.title} ({o.overallScore}/100)
                </option>
              ))}
            </select>
          )}

          {/* Selected opportunity context + halal gate preview */}
          {selectedOpportunity && (
            <div
              className={cn(
                'mt-2 rounded-md border p-2.5 text-xs',
                selectedOpportunity.halalStatus === 'NOT_ALLOWED'
                  ? 'border-red-200 bg-red-50 text-red-800'
                  : selectedOpportunity.halalStatus === 'REVIEW_REQUIRED'
                    ? 'border-amber-200 bg-amber-50 text-amber-800'
                    : 'border-emerald-200 bg-emerald-50 text-emerald-800',
              )}
            >
              {selectedOpportunity.halalStatus === 'NOT_ALLOWED' ? (
                <>
                  <strong>NOT_ALLOWED:</strong> this run will be hard-blocked before any agent
                  or AI call. No pipeline work is performed for prohibited opportunities.
                </>
              ) : selectedOpportunity.halalStatus === 'REVIEW_REQUIRED' ? (
                <>
                  <strong>REVIEW_REQUIRED:</strong> the run will pause for human review — no
                  autonomous execution.
                </>
              ) : (
                <>
                  Status: {selectedOpportunity.status} · halal screening will run before every
                  stage.
                </>
              )}
            </div>
          )}

          {/* Custom objective */}
          {!selectedId && (
            <div className="mt-4">
              <label htmlFor="pipeline-objective" className="mb-1.5 block text-sm font-medium">
                Objective
              </label>
              <textarea
                id="pipeline-objective"
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                rows={3}
                maxLength={2000}
                disabled={running}
                placeholder="e.g. Explore and plan a halal digital product for busy parents who meal-plan weekly"
                className={cn(
                  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500',
                  showObjectiveHint && 'border-red-300',
                )}
              />
              {showObjectiveHint && (
                <p className="mt-1 text-xs text-red-600">
                  Provide an objective or select an opportunity.
                </p>
              )}
            </div>
          )}

          {/* Stage selection */}
          <div className="mt-4">
            <span className="mb-1.5 block text-sm font-medium">Stages</span>
            <div className="space-y-1.5">
              {PIPELINE_ORDER.map((stage) => (
                <label
                  key={stage}
                  className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50"
                >
                  <input
                    type="checkbox"
                    checked={selectedStages.includes(stage)}
                    onChange={() => toggleStage(stage)}
                    disabled={running}
                    className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span>
                    <span className="font-medium">{PIPELINE_STAGE_META[stage].label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {PIPELINE_STAGE_META[stage].description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {selectedStages.length === 0 && (
              <p className="mt-1 text-xs text-red-600">Select at least one stage.</p>
            )}
          </div>

          {/* Run button */}
          <button
            type="button"
            onClick={runPipeline}
            disabled={!canRun || selectedStages.length === 0}
            className={cn(
              'mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium shadow-sm transition-colors',
              !canRun || selectedStages.length === 0
                ? 'cursor-not-allowed bg-slate-100 text-slate-400'
                : 'bg-indigo-600 text-white hover:bg-indigo-700',
            )}
          >
            {running ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Running bounded pipeline…
              </>
            ) : (
              <>
                <Play className="h-4 w-4" />
                Run pipeline
              </>
            )}
          </button>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            Bounded run: agents execute in canonical order with halal gates between stages.
            Failures stop downstream stages safely (fail-closed).
          </p>
        </div>

        {/* Recent runs */}
        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            <Clock className="h-4 w-4" />
            Recent runs
          </h3>
          {recentRuns.length === 0 ? (
            <p className="text-sm text-muted-foreground">No runs recorded yet.</p>
          ) : (
            <ul className="space-y-2.5">
              {recentRuns.map((run) => (
                <li key={run.id} className="rounded-md border p-2.5">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                        STATUS_STYLES[statusKey(run.status)].chip,
                      )}
                    >
                      {run.status}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {formatDateTime(run.startedAt)} · {formatDuration(run.durationMs)}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs font-medium" title={run.objective}>
                    {run.opportunityTitle ?? run.objective}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    lifecycle: {run.currentStage}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Right column: results */}
      <div className="space-y-4 lg:col-span-2">
        {error && (
          <div
            className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
            role="alert"
          >
            <strong>Run failed.</strong> {error}
          </div>
        )}

        {result ? (
          <div className="rounded-xl border bg-card p-5 shadow-sm">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-2 border-b pb-3">
              <div className="min-w-0">
                <h3 className="text-base font-semibold">
                  {result.opportunityId ? (
                    <Link
                      href={`/opportunities/${result.opportunityId}`}
                      className="hover:underline"
                    >
                      {opportunities.find((o) => o.id === result.opportunityId)?.title ??
                        result.opportunityId}
                    </Link>
                  ) : (
                    'Custom objective run'
                  )}
                </h3>
                <p className="mt-0.5 max-w-xl truncate text-xs text-muted-foreground" title={result.objective}>
                  {result.objective}
                </p>
              </div>
              {result.opportunityId && (
                <Link
                  href={`/opportunities/${result.opportunityId}`}
                  className="inline-flex items-center gap-1 text-sm font-medium text-indigo-600 hover:underline"
                >
                  View opportunity
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              )}
            </div>
            <RunResultPanel run={result} />
          </div>
        ) : (
          !running && !error && <EmptyResults />
        )}

        {running && (
          <div className="rounded-xl border bg-card p-8 text-center shadow-sm" aria-busy="true">
            <Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin text-indigo-600" />
            <h3 className="text-lg font-semibold">Running the bounded pipeline…</h3>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              Research, validation, product, experiment planning, and tracking run in order with
              halal gates between stages. This can take up to a minute in live-AI mode.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
