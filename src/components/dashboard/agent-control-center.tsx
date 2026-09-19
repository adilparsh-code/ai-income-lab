'use client';

// Phase 6 — INTELLIGENT AGENT CONTROL CENTER (dashboard section).
// Renders the deterministic intelligence view for the top actionable
// opportunity: current stage, next step, reason, evidence strength, missing
// evidence, conflicts, human review, Ruflo status, AI provider status, and the
// latest business decision. Every value comes from the server-assembled
// AgentContext (stored records only) — nothing is fabricated here. Provenance
// labels (VERIFIED_DATA / AI_INFERENCE / USER_ENTERED / MOCKED) are preserved
// exactly as recorded.

import { cn } from '@/lib/utils';
import { Brain, Crown, GitBranch, ShieldAlert, Sparkles } from 'lucide-react';
import type { ControlCenterView } from '@/lib/agents/control-center';

function Badge({ label, tone }: { label: string; tone: 'good' | 'warn' | 'bad' | 'muted' | 'info' }) {
  const toneClass =
    tone === 'good'
      ? 'bg-emerald-100 text-emerald-700'
      : tone === 'warn'
        ? 'bg-amber-100 text-amber-800'
        : tone === 'bad'
          ? 'bg-red-100 text-red-700'
          : tone === 'info'
            ? 'bg-indigo-100 text-indigo-700'
            : 'bg-slate-100 text-slate-600';
  return <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold', toneClass)}>{label}</span>;
}

function strengthTone(strength: string): 'good' | 'warn' | 'bad' | 'muted' {
  switch (strength) {
    case 'VERIFIED':
      return 'good';
    case 'SUPPORTED':
    case 'PARTIAL':
      return 'warn';
    case 'CONFLICTING':
      return 'bad';
    default:
      return 'muted';
  }
}

export function AgentControlCenter({ view }: { view: ControlCenterView | null }) {
  if (!view) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        Intelligent Agent Control Center is unavailable right now (context assembly failed).
        Nothing is fabricated while it is down.
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card p-5 shadow-sm">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        {/* Opportunity + stage */}
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <Brain className="h-4 w-4 text-indigo-600" />
            <h3 className="text-sm font-semibold">Intelligent Agent Control Center</h3>
            <Badge label={view.ruflo.status} tone={view.ruflo.connected ? 'good' : 'muted'} />
            <Badge
              label={'AI ' + view.aiProvider.capabilityStatus}
              tone={view.aiProvider.isLive ? 'good' : 'warn'}
            />
          </div>
          {view.opportunity ? (
            <>
              <p className="text-lg font-semibold leading-tight">{view.opportunity.title}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Score {view.opportunity.overallScore} · status {view.opportunity.status} · halal {view.opportunity.halalStatus}
              </p>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border bg-muted/30 p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Current stage</p>
                  <p className="mt-1 text-sm font-medium">{view.currentStage}</p>
                </div>
                <div className="rounded-lg border bg-muted/30 p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Next step</p>
                  {view.nextStep ? (
                    <>
                      <p className="mt-1 text-sm font-medium">
                        {view.nextStep.action}
                        {view.nextStep.agent ? <span className="text-muted-foreground"> · {view.nextStep.agent}</span> : null}
                      </p>
                      <p className="mt-1 text-xs leading-snug text-muted-foreground">{view.nextStep.reason}</p>
                    </>
                  ) : (
                    <p className="mt-1 text-sm text-muted-foreground">No recorded state to act on.</p>
                  )}
                </div>
              </div>
            </>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              No active opportunity. Create one to start the loop.
            </p>
          )}
        </div>

        {/* Right rail: evidence, review, ruflo */}
        <div className="w-full space-y-3 lg:w-80">
          {view.evidenceStrength && (
            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Evidence strength</p>
              <div className="mt-1 flex items-center gap-2">
                <Badge label={view.evidenceStrength.strength} tone={strengthTone(view.evidenceStrength.strength)} />
              </div>
              <p className="mt-1.5 text-xs leading-snug text-muted-foreground">{view.evidenceStrength.basis}</p>
            </div>
          )}

          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Human review</p>
            <div className="mt-1 flex items-center gap-2">
              <Badge
                label={view.humanReview.required ? 'REQUIRED' : 'NOT REQUIRED'}
                tone={view.humanReview.required ? 'bad' : 'good'}
              />
            </div>
            {view.humanReview.reason && (
              <p className="mt-1.5 text-xs leading-snug text-muted-foreground">{view.humanReview.reason}</p>
            )}
          </div>

          {view.conflicts?.hasConflict && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
              <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
                <ShieldAlert className="h-3 w-3" /> Conflict detected
              </p>
              <p className="mt-1 text-xs leading-snug text-amber-900">{view.conflicts.description}</p>
              <p className="mt-1 text-[11px] font-medium text-amber-900">
                Safe action: {view.conflicts.safeAction.replace(/_/g, ' ')}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {view.conflicts.positions.map((p) => (
                  <span key={p.agent} className="rounded bg-white px-1.5 py-0.5 text-[10px] text-amber-900 border border-amber-200">
                    {p.agent}: {p.signal} ({p.evidenceType})
                  </span>
                ))}
              </div>
            </div>
          )}

          {view.provenance && (
            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Context provenance
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <Badge label={`VERIFIED ${view.provenance.verified}`} tone="good" />
                <Badge label={`USER ${view.provenance.userEntered}`} tone="info" />
                <Badge label={`AI_INFERENCE ${view.provenance.aiInference}`} tone="warn" />
                {view.provenance.mocked > 0 && <Badge label={`MOCKED ${view.provenance.mocked}`} tone="muted" />}
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                {view.handoffCount} handoff(s) · {view.missingEvidence.length} missing evidence item(s)
              </p>
            </div>
          )}

          {view.latestDecision && (
            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                <Crown className="h-3 w-3" /> Latest business decision
              </p>
              <p className="mt-1 text-xs font-medium">
                {view.latestDecision.decision} → {view.latestDecision.action}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {new Date(view.latestDecision.recordedAt).toLocaleString()}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Missing evidence + memory */}
      {(view.missingEvidence.length > 0 || view.businessMemory.length > 0) && (
        <div className="mt-4 grid gap-3 border-t pt-4 sm:grid-cols-2">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Missing evidence</p>
            {view.missingEvidence.length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">None — all core evidence on file.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {view.missingEvidence.slice(0, 6).map((m) => (
                  <li key={m} className="text-xs leading-snug text-muted-foreground">• {m}</li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <GitBranch className="h-3 w-3" /> Business memory (bounded, provenance-labelled)
            </p>
            {view.businessMemory.length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">No memory recorded for this opportunity yet.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {view.businessMemory.slice(0, 4).map((m) => (
                  <li key={m.label + m.text.slice(0, 24)} className="text-xs leading-snug text-muted-foreground">
                    <span className="font-medium text-foreground/70">[{m.evidenceType}]</span> {m.text}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <p className="mt-3 flex items-center gap-1 text-[11px] text-muted-foreground">
        <Sparkles className="h-3 w-3" />
        Deterministic routing + conflict assessment over stored records. AI never overrides halal gates, human review, or verified data. Assembled {new Date(view.assembledAt).toLocaleTimeString()}.
      </p>
    </div>
  );
}
