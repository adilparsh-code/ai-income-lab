'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  ExternalLink,
  Factory,
  Loader2,
  Package,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { generateProductConcept, getFactoryRunDetail } from '@/actions/product-factory';
import type { FactoryOpportunityOption, FactoryRunSummary } from '@/actions/product-factory';
import type {
  FactoryEvidenceSource,
  FactoryRunView,
  FactoryWorkflowStep,
} from '@/lib/product-factory/factory-logic';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Shared presentational helpers
// ---------------------------------------------------------------------------

const PROVENANCE_STYLES: Record<string, string> = {
  VERIFIED_DATA: 'bg-emerald-100 text-emerald-700',
  SEARCH_DISCOVERY: 'bg-sky-100 text-sky-700',
  AI_INFERENCE: 'bg-blue-100 text-blue-700',
  USER_ENTERED: 'bg-purple-100 text-purple-700',
  MOCKED: 'bg-slate-100 text-slate-600',
};

function ProvenanceBadge({ type }: { type: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium',
        PROVENANCE_STYLES[type] ?? 'bg-slate-100 text-slate-600',
      )}
    >
      {type.replace(/_/g, ' ')}
    </span>
  );
}

const MODE_STYLES: Record<FactoryRunView['dataMode'], { chip: string; label: string }> = {
  LIVE: { chip: 'bg-emerald-100 text-emerald-700', label: 'LIVE DATA' },
  MOCKED: { chip: 'bg-amber-100 text-amber-700', label: 'MOCKED — deterministic offline output' },
  PLANNED: { chip: 'bg-slate-100 text-slate-600', label: 'PLANNED — nothing has run yet' },
};

const STEP_STATE_STYLES: Record<FactoryWorkflowStep['state'], string> = {
  READY: 'bg-emerald-100 text-emerald-700',
  PENDING: 'bg-slate-50 text-slate-400 border border-slate-200',
  FAILED: 'bg-red-100 text-red-700',
  BLOCKED: 'bg-red-100 text-red-700',
};

const STEP_STATE_ICONS: Record<FactoryWorkflowStep['state'], typeof CheckCircle2> = {
  READY: CheckCircle2,
  PENDING: Circle,
  FAILED: XCircle,
  BLOCKED: XCircle,
};

type StatusKey = 'COMPLETED' | 'PARTIAL' | 'BLOCKED' | 'HUMAN_REVIEW' | 'FAILED';

const STATUS_STYLES: Record<StatusKey, { banner: string; label: string }> = {
  COMPLETED: { banner: 'border-emerald-200 bg-emerald-50 text-emerald-900', label: 'Completed' },
  PARTIAL: { banner: 'border-amber-200 bg-amber-50 text-amber-900', label: 'Partial — failed safely' },
  BLOCKED: { banner: 'border-red-200 bg-red-50 text-red-900', label: 'Blocked (NOT_ALLOWED)' },
  HUMAN_REVIEW: { banner: 'border-indigo-200 bg-indigo-50 text-indigo-900', label: 'Human review required' },
  FAILED: { banner: 'border-red-200 bg-red-50 text-red-900', label: 'Failed' },
};

function statusKey(value: string): StatusKey {
  return (['COMPLETED', 'PARTIAL', 'BLOCKED', 'HUMAN_REVIEW', 'FAILED'] as const).includes(value as StatusKey)
    ? (value as StatusKey)
    : 'FAILED';
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-card p-5">
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

function BulletList({ items, tone = 'default' }: { items: string[]; tone?: 'default' | 'warning' }) {
  if (items.length === 0) return null;
  return (
    <ul className="space-y-1.5">
      {items.map((item, i) => (
        <li key={`${item.slice(0, 24)}-${i}`} className="flex items-start gap-2 text-sm">
          <span
            className={cn(
              'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
              tone === 'warning' ? 'bg-amber-500' : 'bg-indigo-400',
            )}
          />
          <span className={tone === 'warning' ? 'text-amber-900' : 'text-foreground/90'}>{item}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Workflow rail
// ---------------------------------------------------------------------------

function WorkflowRail({ workflow }: { workflow: FactoryWorkflowStep[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {workflow.map((step, i) => {
        const Icon = STEP_STATE_ICONS[step.state];
        return (
          <span key={step.key} className="flex items-center gap-1.5">
            {i > 0 && <ArrowRight className="h-3 w-3 text-muted-foreground/50" />}
            <span
              title={`${step.description}${step.detail ? ` — ${step.detail}` : ''}`}
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium',
                STEP_STATE_STYLES[step.state],
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {step.label}
            </span>
          </span>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Evidence chain
// ---------------------------------------------------------------------------

function EvidenceSourceCard({ source }: { source: FactoryEvidenceSource }) {
  const verified = source.evidenceType === 'VERIFIED_DATA';
  return (
    <div className={cn('rounded-lg border p-3', verified ? '' : 'border-dashed')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium" title={source.title}>
            {source.title || source.domain}
          </p>
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className={cn(
              'mt-0.5 inline-flex items-center gap-1 text-xs hover:underline',
              verified ? 'text-indigo-600' : 'text-sky-700',
            )}
          >
            {source.url}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        <ProvenanceBadge type={source.evidenceType} />
      </div>
      {source.excerpt && <p className="mt-2 text-xs text-muted-foreground">{source.excerpt}</p>}
      {source.snippet && <p className="mt-2 text-xs text-muted-foreground">{source.snippet}</p>}
      <p className="mt-2 text-[11px] text-muted-foreground">
        {verified ? 'Fetched' : 'Discovered'} {source.retrievedAt ? formatDateTime(source.retrievedAt) : '—'}
        {verified ? ` · HTTP ${source.httpStatus ?? '—'} · ${(source.contentLength ?? 0).toLocaleString()} bytes` : ' · not fetched · not verified'}
      </p>
    </div>
  );
}

function EvidenceSection({ evidence }: { evidence: FactoryRunView['evidence'] }) {
  if (evidence.sources.length === 0 && !evidence.report) {
    return (
      <p className="text-sm text-muted-foreground">
        No external evidence was collected for this run. Everything shown is AI inference and user input.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {evidence.report && (
        <div
          className={cn(
            'rounded-lg border p-3 text-xs',
            evidence.report.status === 'OK'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : evidence.report.status === 'PARTIAL'
                ? 'border-amber-200 bg-amber-50 text-amber-900'
                : evidence.report.status === 'NOT_CONFIGURED'
                  ? 'border-sky-200 bg-sky-50 text-sky-900'
                  : 'border-red-200 bg-red-50 text-red-900',
          )}
        >
          <span className="font-semibold">Real research: {evidence.report.status.replace(/_/g, ' ')}</span>
          {evidence.report.searchProviderId && (
            <span className="ml-2">provider: {evidence.report.searchProviderId}</span>
          )}
          <span className="ml-2">served from: {evidence.report.servedFrom}</span>
        </div>
      )}
      <div className="grid gap-2 md:grid-cols-2">
        {evidence.sources.map((source) => (
          <EvidenceSourceCard key={source.url} source={source} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Product sections
// ---------------------------------------------------------------------------

function ConceptSection({ view }: { view: FactoryRunView }) {
  const concept = view.product.concept;
  if (!concept) {
    return (
      <p className="text-sm text-muted-foreground">
        No product concept was produced by this run{view.status === 'BLOCKED' ? ' — generation is blocked by halal compliance' : ''}.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-base font-semibold">{concept.name || 'Unnamed concept'}</span>
        <ProvenanceBadge type={concept.evidenceType} />
      </div>
      <p className="text-sm text-foreground/90">{concept.oneLine}</p>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Customer</dt>
          <dd>{concept.customer}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Problem</dt>
          <dd>{concept.problem}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Solution</dt>
          <dd>{concept.solution}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Value proposition</dt>
          <dd>{concept.valueProposition}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Differentiation (hypothesis)</dt>
          <dd>{concept.differentiation}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Format</dt>
          <dd>{concept.format}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Primary use case</dt>
          <dd>{concept.useCase}</dd>
        </div>
      </dl>
    </div>
  );
}

const FEATURE_PRIORITY_STYLES: Record<string, string> = {
  ESSENTIAL: 'bg-indigo-100 text-indigo-700',
  IMPORTANT: 'bg-blue-100 text-blue-700',
  DEFERRED: 'bg-slate-100 text-slate-600',
};

function MvpSection({ view }: { view: FactoryRunView }) {
  const features = view.product.mvpFeatures;
  if (features.length === 0) {
    return <p className="text-sm text-muted-foreground">No MVP features were produced by this run.</p>;
  }
  return (
    <ul className="space-y-2">
      {features.map((feature) => (
        <li key={feature.name} className="rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{feature.name}</span>
            <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', FEATURE_PRIORITY_STYLES[feature.priority] ?? FEATURE_PRIORITY_STYLES.IMPORTANT)}>
              {feature.priority}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{feature.description}</p>
        </li>
      ))}
    </ul>
  );
}

function BuildPlanSection({ view }: { view: FactoryRunView }) {
  const phases = view.product.buildPhases;
  if (phases.length === 0) {
    return <p className="text-sm text-muted-foreground">No build plan was produced by this run.</p>;
  }
  return (
    <ol className="space-y-3">
      {phases.map((phase) => (
        <li key={`${phase.phase}-${phase.name}`} className="rounded-lg border p-4">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-100 text-xs font-semibold text-indigo-700">
              {phase.phase}
            </span>
            <span className="text-sm font-medium">{phase.name}</span>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Output: {phase.expectedOutput}</p>
          <p className="mt-1 text-xs text-amber-800">Risk: {phase.risk}</p>
          {phase.tasks.length > 0 && (
            <ul className="mt-2 space-y-1">
              {phase.tasks.map((task, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" />
                  {task}
                </li>
              ))}
            </ul>
          )}
          {phase.dependencies.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">Depends on: {phase.dependencies.join(', ')}</p>
          )}
        </li>
      ))}
    </ol>
  );
}

function MonetizationSection({ view }: { view: FactoryRunView }) {
  const monetization = view.product.monetization;
  if (!monetization) {
    return <p className="text-sm text-muted-foreground">No monetization view was produced by this run.</p>;
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700">
          {monetization.model.replace(/_/g, ' ')}
        </span>
        <span className="text-xs text-muted-foreground">Pricing hypothesis — never a verified market price</span>
      </div>
      <p className="text-sm text-foreground/90">{monetization.rationale}</p>
      <p className="text-sm">{monetization.pricingHypothesis}</p>
      <BulletList items={monetization.assumptions} />
    </div>
  );
}

function DistributionSection({ view }: { view: FactoryRunView }) {
  const distribution = view.product.distribution;
  if (!distribution) {
    return <p className="text-sm text-muted-foreground">No distribution view was produced by this run.</p>;
  }
  return (
    <div className="space-y-3">
      {distribution.channels.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Channels (hypotheses)</h4>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {distribution.channels.map((channel, i) => (
              <span key={i} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700">
                {channel}
              </span>
            ))}
          </div>
        </div>
      )}
      {distribution.contentStrategy && (
        <p className="text-sm text-foreground/90">{distribution.contentStrategy}</p>
      )}
      {distribution.landingPageConcept && (
        <p className="text-sm text-foreground/90">{distribution.landingPageConcept}</p>
      )}
      {distribution.conversionPath.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Conversion path</h4>
          <ul className="mt-1.5 space-y-1">
            {distribution.conversionPath.map((step, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <ArrowRight className="mt-1 h-3.5 w-3.5 shrink-0 text-indigo-400" />
                {step}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main workspace
// ---------------------------------------------------------------------------

interface ProductFactoryWorkspaceProps {
  opportunities: FactoryOpportunityOption[];
  recentRuns: FactoryRunSummary[];
}

export function ProductFactoryWorkspace({ opportunities, recentRuns }: ProductFactoryWorkspaceProps) {
  const [selectedOpportunityId, setSelectedOpportunityId] = useState('');
  const [productType, setProductType] = useState('DIGITAL_PRODUCT');
  const [monetization, setMonetization] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<FactoryRunView | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const selectedOpportunity = useMemo(
    () => opportunities.find((o) => o.id === selectedOpportunityId) ?? null,
    [opportunities, selectedOpportunityId],
  );

  const halalPreview = selectedOpportunity?.halalStatus ?? null;
  const blockedOpportunity = halalPreview === 'NOT_ALLOWED';

  async function handleGenerate() {
    setRunning(true);
    setError(null);
    try {
      const result = await generateProductConcept({
        opportunityId: selectedOpportunityId || undefined,
        productType,
        monetizationPreference: monetization || undefined,
      });
      if (result.ok) {
        setView(result.view);
        setActiveRunId(result.runId || null);
      } else {
        setError(result.error);
      }
    } catch {
      setError('Product generation failed unexpectedly. Try again.');
    } finally {
      setRunning(false);
    }
  }

  async function handleLoadRun(runId: string) {
    setError(null);
    try {
      const result = await getFactoryRunDetail(runId);
      if (result.ok) {
        setView(result.view);
        setActiveRunId(runId);
      } else {
        setError(result.error);
      }
    } catch {
      setError('The run could not be loaded. Try again.');
    }
  }

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="rounded-xl border bg-card p-5">
        <div className="grid gap-4 md:grid-cols-3">
          <label className="space-y-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Opportunity</span>
            <select
              value={selectedOpportunityId}
              onChange={(e) => setSelectedOpportunityId(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            >
              <option value="">— Free-form objective —</option>
              {opportunities.map((opportunity) => (
                <option key={opportunity.id} value={opportunity.id}>
                  {opportunity.title} ({opportunity.halalStatus.replace(/_/g, ' ')}, score {opportunity.overallScore})
                </option>
              ))}
            </select>
            {halalPreview && (
              <span
                className={cn(
                  'inline-flex items-center gap-1 text-xs',
                  halalPreview === 'NOT_ALLOWED'
                    ? 'text-red-600'
                    : halalPreview === 'REVIEW_REQUIRED'
                      ? 'text-amber-600'
                      : 'text-emerald-600',
                )}
              >
                <ShieldCheck className="h-3 w-3" />
                Halal screening: {halalPreview.replace(/_/g, ' ')}
                {blockedOpportunity ? ' — generation will be hard-blocked' : halalPreview === 'REVIEW_REQUIRED' ? ' — will pause for human review' : ''}
              </span>
            )}
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Product type</span>
            <select
              value={productType}
              onChange={(e) => setProductType(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            >
              {['DIGITAL_PRODUCT', 'PRINTABLE', 'TEMPLATE', 'COURSE', 'TOOL', 'SAAS', 'WEB_APP', 'MOBILE_APP', 'SERVICE_PRODUCT'].map((type) => (
                <option key={type} value={type}>
                  {type.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Monetization preference (optional)</span>
            <select
              value={monetization}
              onChange={(e) => setMonetization(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            >
              <option value="">— Agent decides —</option>
              {['ONE_TIME_PURCHASE', 'SUBSCRIPTION', 'FREEMIUM', 'SERVICE', 'LICENSE', 'AFFILIATE', 'AD_SUPPORTED'].map((model) => (
                <option key={model} value={model}>
                  {model.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            onClick={handleGenerate}
            disabled={running}
            className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Factory className="h-4 w-4" />}
            {running ? 'Generating…' : 'Generate product concept'}
          </button>
          {running && (
            <span className="text-xs text-muted-foreground">
              Running the bounded pipeline: research → validation → product. This may take a moment.
            </span>
          )}
        </div>
        {error && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
            {error}
          </div>
        )}
      </div>

      {/* Empty state */}
      {!view && !running && (
        <div className="rounded-xl border border-dashed p-10 text-center">
          <Package className="mx-auto h-10 w-10 text-muted-foreground/50" />
          <h3 className="mt-3 text-sm font-semibold">No product generated yet</h3>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Select an opportunity and generate a concept. The factory reuses the existing pipeline: real research
            evidence, a validation plan, and a product specification — each field labelled with its provenance.
          </p>
        </div>
      )}

      {/* Result */}
      {view && (
        <div className="space-y-6">
          <div className={cn('rounded-xl border p-4 text-sm', STATUS_STYLES[statusKey(view.status)].banner)}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{STATUS_STYLES[statusKey(view.status)].label}</span>
              <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', MODE_STYLES[view.dataMode].chip)}>
                {MODE_STYLES[view.dataMode].label}
              </span>
              {view.humanReviewRequired && (
                <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700">
                  REVIEW_REQUIRED — human review before any action
                </span>
              )}
            </div>
            <p className="mt-2">{view.reasoning}</p>
          </div>

          <div className="rounded-xl border bg-card p-4">
            <WorkflowRail workflow={view.workflow} />
            {activeRunId && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                Persisted run <span className="font-mono">{activeRunId}</span> · full evidence chain stored for audit.
              </p>
            )}
          </div>

          <Section title="Evidence chain — Real Research Engine">
            <EvidenceSection evidence={view.evidence} />
          </Section>

          {view.validation && (
            <Section title="Validation plan">
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                    {view.validation.recommendation.replace(/_/g, ' ')}
                  </span>
                  {view.validation.confidence !== null && (
                    <span className="text-xs text-muted-foreground">
                      confidence {(view.validation.confidence * 100).toFixed(0)}%
                    </span>
                  )}
                </div>
                {view.validation.assumptions.length > 0 && (
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Assumptions</h4>
                    <BulletList items={view.validation.assumptions} />
                  </div>
                )}
                {view.validation.tests.length > 0 && (
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Validation tests</h4>
                    <ul className="mt-1.5 space-y-1.5">
                      {view.validation.tests.map((test, i) => (
                        <li key={i} className="text-sm">
                          <span className="font-medium">{test.name}</span>
                          <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">
                            {test.method.replace(/_/g, ' ')}
                          </span>
                          <p className="text-xs text-muted-foreground">{test.description}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {view.validation.risks.length > 0 && (
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Risks</h4>
                    <BulletList items={view.validation.risks.map((r) => `${r.risk} [${r.severity}]`)} tone="warning" />
                  </div>
                )}
                {view.validation.successCriteria.length > 0 && (
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Success criteria</h4>
                    <BulletList items={view.validation.successCriteria} />
                  </div>
                )}
              </div>
            </Section>
          )}

          <Section title="Product concept">
            <ConceptSection view={view} />
          </Section>

          <Section title="MVP specification">
            <MvpSection view={view} />
          </Section>

          <Section title="Build plan">
            <BuildPlanSection view={view} />
          </Section>

          <Section title="Monetization (hypotheses)">
            <MonetizationSection view={view} />
          </Section>

          <Section title="Distribution (hypotheses)">
            <DistributionSection view={view} />
          </Section>

          <div className="grid gap-6 md:grid-cols-2">
            <Section title="Missing evidence">
              {view.missingEvidence.length === 0 ? (
                <p className="text-sm text-muted-foreground">No missing-evidence notes were recorded for this run.</p>
              ) : (
                <BulletList items={view.missingEvidence} tone="warning" />
              )}
            </Section>
            <Section title="Next actions">
              {view.nextActions.length === 0 ? (
                <p className="text-sm text-muted-foreground">No next actions were produced by this run.</p>
              ) : (
                <BulletList items={view.nextActions} />
              )}
            </Section>
          </div>

          <Section title="Provenance & AI usage">
            <div className="space-y-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                {Object.entries(view.provenance.counts).map(([type, count]) => (
                  <span key={type} className="inline-flex items-center gap-1 text-xs">
                    <ProvenanceBadge type={type} />
                    <span className="text-muted-foreground">×{count}</span>
                  </span>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                External sources: {view.provenance.sourceCounts.VERIFIED_DATA} verified fetch(es),{' '}
                {view.provenance.sourceCounts.SEARCH_DISCOVERY} discovery lead(s). AI usage:{' '}
                {view.provenance.aiUsage.liveSteps} live step(s), {view.provenance.aiUsage.fallbackSteps} fallback
                step(s). Publishing, spending, pricing commitments, and marketplace submissions remain human-gated.
              </p>
            </div>
          </Section>
        </div>
      )}

      {/* Run history */}
      {recentRuns.length > 0 && (
        <div className="rounded-xl border bg-card p-5">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Recent factory runs
          </h3>
          <ul className="divide-y">
            {recentRuns.map((run) => (
              <li key={run.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{run.objective}</p>
                  <p className="text-xs text-muted-foreground">
                    {run.opportunityTitle ? `${run.opportunityTitle} · ` : ''}
                    {formatDateTime(run.startedAt)} · {formatDuration(run.durationMs)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-xs font-medium',
                      run.status === 'COMPLETED'
                        ? 'bg-emerald-100 text-emerald-700'
                        : run.status === 'BLOCKED'
                          ? 'bg-red-100 text-red-700'
                          : run.status === 'HUMAN_REVIEW'
                            ? 'bg-indigo-100 text-indigo-700'
                            : 'bg-amber-100 text-amber-700',
                    )}
                  >
                    {run.status.replace(/_/g, ' ')}
                  </span>
                  <button
                    onClick={() => handleLoadRun(run.id)}
                    className="rounded-md border px-2.5 py-1 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50"
                  >
                    View
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Need the full loop including experiment planning and tracking? Use the{' '}
        <Link href="/pipeline" className="text-indigo-600 hover:underline">
          Opportunity → Product Pipeline
        </Link>
        .
      </p>
    </div>
  );
}
