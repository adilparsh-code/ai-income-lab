import type { OpportunityLifecycleView } from '@/lib/ruflo/lifecycle';
import { cn, getScoreColor } from '@/lib/utils';
import { CheckCircle2, Circle, CircleDot, ShieldAlert } from 'lucide-react';
import Link from 'next/link';

const STAGE_LABELS: Record<string, string> = {
  DISCOVER: 'Discover',
  RESEARCH: 'Research',
  VALIDATE: 'Validate',
  DECIDE: 'Decide',
  BUILD: 'Build',
  PUBLISH: 'Publish',
  MARKET: 'Market',
  MEASURE: 'Measure',
  IMPROVE: 'Improve',
};

interface LifecyclePipelineProps {
  opportunities: OpportunityLifecycleView[];
}

/**
 * Business-loop lifecycle overview (Phase 4.2.4). Renders real lifecycle state
 * per opportunity — current stage, evidence presence, and what is missing.
 * Every value shown comes from database records; nothing is fabricated.
 */
export function LifecyclePipeline({ opportunities }: LifecyclePipelineProps) {
  if (opportunities.length === 0) {
    return (
      <div className="rounded-xl border-2 border-dashed border-muted-foreground/25 bg-muted/30 p-8 text-center">
        <Circle className="h-8 w-8 mx-auto text-muted-foreground/50 mb-3" />
        <h3 className="text-lg font-semibold mb-1">No Lifecycle Data Yet</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Add an opportunity to start the business loop: discover → research → validate → build → publish → measure.
        </p>
        <Link
          href="/opportunities/new"
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90 transition-colors"
        >
          Add Your First Opportunity
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {opportunities.slice(0, 5).map((view) => (
        <div
          key={view.opportunity.id}
          className="rounded-xl border bg-card p-4 shadow-sm"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-2 min-w-0">
              {view.halalStatus === 'NOT_ALLOWED' && (
                <ShieldAlert className="h-4 w-4 text-red-500 shrink-0" aria-label="NOT_ALLOWED" />
              )}
              <Link
                href={`/opportunities/${view.opportunity.id}`}
                className="font-medium text-sm truncate hover:underline"
              >
                {view.opportunity.title}
              </Link>
              {view.halalStatus !== 'HALAL' && (
                <span
                  className={cn(
                    'rounded px-1.5 py-0.5 text-[10px] font-medium',
                    view.halalStatus === 'NOT_ALLOWED'
                      ? 'bg-red-100 text-red-700'
                      : 'bg-amber-100 text-amber-700'
                  )}
                >
                  {view.halalStatus.replace(/_/g, ' ')}
                </span>
              )}
            </div>
            <span className={cn('text-xs font-semibold', getScoreColor(view.opportunity.overallScore))}>
              {view.opportunity.overallScore}/100
            </span>
          </div>

          {/* Stage rail */}
          <div className="flex flex-wrap items-center gap-1.5">
            {view.stages.map((stage, idx) => (
              <div key={stage.stage} className="flex items-center gap-1.5">
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
                    stage.isCurrent
                      ? 'bg-indigo-600 text-white shadow-sm'
                      : stage.hasEvidence
                        ? 'bg-emerald-100 text-emerald-700'
                        : idx < view.stages.findIndex((s) => s.isCurrent)
                          ? 'bg-slate-100 text-slate-500'
                          : 'bg-slate-50 text-slate-400 border border-slate-200'
                  )}
                  title={
                    stage.missingEvidence.length > 0
                      ? stage.missingEvidence.join(' ')
                      : stage.state
                  }
                >
                  {stage.isCurrent ? (
                    <CircleDot className="h-3 w-3" />
                  ) : stage.hasEvidence ? (
                    <CheckCircle2 className="h-3 w-3" />
                  ) : (
                    <Circle className="h-3 w-3" />
                  )}
                  {STAGE_LABELS[stage.stage] ?? stage.stage}
                </span>
              </div>
            ))}
          </div>

          <p className="mt-3 text-xs text-muted-foreground">
            {view.rationale}
            {view.stages
              .find((s) => s.isCurrent)
              ?.missingEvidence.map((m) => ` ${m}`)
              .join('')}
          </p>
        </div>
      ))}
    </div>
  );
}
