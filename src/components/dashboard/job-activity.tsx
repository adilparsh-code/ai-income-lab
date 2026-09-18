// Compact Job/Agent Activity section for the dashboard (Phase 4.5.2).
// Server component over the safe activity listing — no payloads, no secrets,
// no fabricated rows: only recorded JobRun entries are rendered.

import Link from 'next/link';
import { ArrowRight, ListTodo } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { JobActivityItem } from '@/lib/jobs/job-registry';

const STATUS_STYLES: Record<string, string> = {
  QUEUED: 'bg-slate-100 text-slate-600',
  RUNNING: 'bg-blue-100 text-blue-700',
  SUCCEEDED: 'bg-emerald-100 text-emerald-700',
  FAILED: 'bg-red-100 text-red-700',
  BLOCKED: 'bg-red-100 text-red-700',
  HUMAN_REVIEW: 'bg-indigo-100 text-indigo-700',
  DEGRADED: 'bg-amber-100 text-amber-700',
};

const STATUS_LABELS: Record<string, string> = {
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  BLOCKED: 'BLOCKED',
  HUMAN_REVIEW: 'HUMAN REVIEW',
  DEGRADED: 'DEGRADED',
};

function modeLabel(mode: JobActivityItem['executionMode']): string {
  return mode === 'LIVE' ? 'LIVE' : 'MOCK';
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function JobActivity({ jobs, rufloStatus }: { jobs: JobActivityItem[]; rufloStatus: string }) {
  return (
    <div className="rounded-xl border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div className="flex items-center gap-2">
          <ListTodo className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-semibold text-sm">Job / Agent Activity</h3>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700">
            {rufloStatus}
          </span>
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
            ORCHESTRATION READY — NOT CONNECTED
          </span>
        </div>
      </div>

      {jobs.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No jobs have run yet. Jobs created via the API or future orchestration will appear here with
          status, execution mode, and gating information.
        </p>
      ) : (
        <ul className="space-y-2">
          {jobs.map((job) => (
            <li key={job.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/20 px-3 py-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="font-mono text-xs font-medium">{job.jobType}</span>
                {job.agentType && (
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                    {job.agentType}
                  </span>
                )}
                <span
                  className={cn(
                    'rounded px-1.5 py-0.5 text-[10px] font-semibold',
                    STATUS_STYLES[job.status] ?? 'bg-slate-100 text-slate-600'
                  )}
                >
                  {STATUS_LABELS[job.status] ?? job.status}
                </span>
                <span
                  className={cn(
                    'rounded px-1.5 py-0.5 text-[10px] font-medium',
                    job.executionMode === 'LIVE' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'
                  )}
                >
                  {modeLabel(job.executionMode)}
                </span>
                {job.degraded && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">AI INFERENCE (fallback)</span>
                )}
                {job.humanReview && (
                  <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">HUMAN REVIEW</span>
                )}
                {job.blocked && (
                  <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">BLOCKED</span>
                )}
              </div>
              <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                <span title="created">{formatTime(job.createdAt)}</span>
                {job.completedAt && <span title="completed">→ {formatTime(job.completedAt)}</span>}
                {job.opportunityId && (
                  <Link href={`/opportunities/${job.opportunityId}`} className="underline hover:text-foreground">
                    opportunity
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
        <ArrowRight className="h-3 w-3" />
        <span>
          Automation flow (planned): scheduler → research → validation → product → analytics → next best action →
          human approval. Publishing, spending, and irreversible actions remain human-gated.
        </span>
      </div>
    </div>
  );
}
