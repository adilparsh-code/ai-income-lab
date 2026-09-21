import { ExternalLink, Globe, Search, ShieldCheck, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ResearchResult } from '@/lib/agents/types';

// ---------------------------------------------------------------------------
// Provenance badge styling
// ---------------------------------------------------------------------------

const PROVENANCE_STYLES: Record<string, string> = {
  VERIFIED_DATA: 'bg-emerald-100 text-emerald-700',
  SEARCH_DISCOVERY: 'bg-sky-100 text-sky-700',
  AI_INFERENCE: 'bg-blue-100 text-blue-700',
  USER_ENTERED: 'bg-purple-100 text-purple-700',
};

export function ProvenanceBadge({ type }: { type: string }) {
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

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Source list (VERIFIED_DATA + SEARCH_DISCOVERY, each with URL + timestamp)
// ---------------------------------------------------------------------------

export function ResearchSourceList({ result }: { result: ResearchResult }) {
  if (result.sources.length === 0) {
    return null;
  }

  const verified = result.sources.filter((s) => s.evidenceType === 'VERIFIED_DATA');
  const discovery = result.sources.filter((s) => s.evidenceType === 'SEARCH_DISCOVERY');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Globe className="h-3.5 w-3.5" />
        <span>
          {verified.length} verified source{verified.length === 1 ? '' : 's'} ·{' '}
          {discovery.length} discovery lead{discovery.length === 1 ? '' : 's'} ·{' '}
          {result.sourceResearch ? `served from ${result.sourceResearch.servedFrom}` : 'no external fetch'}
        </span>
      </div>

      {verified.length > 0 && (
        <div className="space-y-2">
          <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
            Verified sources — fetched from origin
          </h4>
          {verified.map((source) => (
            <div key={`v-${source.url}`} className="rounded-lg border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium" title={source.title}>
                    {source.title || source.domain}
                  </p>
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="mt-0.5 inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline"
                  >
                    {source.url}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
                <ProvenanceBadge type={source.evidenceType} />
              </div>
              {source.excerpt && (
                <p className="mt-2 text-xs text-muted-foreground">{source.excerpt}</p>
              )}
              <p className="mt-2 text-[11px] text-muted-foreground">
                Retrieved {formatTimestamp(source.retrievedAt)} · HTTP {source.httpStatus ?? '—'} ·{' '}
                {source.contentType ?? 'unknown type'} · {(source.contentLength ?? 0).toLocaleString()} bytes
              </p>
            </div>
          ))}
        </div>
      )}

      {discovery.length > 0 && (
        <div className="space-y-2">
          <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Search className="h-3.5 w-3.5 text-sky-600" />
            Discovery leads — search metadata only, never fetched
          </h4>
          {discovery.map((source) => (
            <div key={`d-${source.url}`} className="rounded-lg border border-dashed p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium" title={source.title}>
                    {source.title || source.domain}
                  </p>
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="mt-0.5 inline-flex items-center gap-1 text-xs text-sky-700 hover:underline"
                  >
                    {source.url}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
                <ProvenanceBadge type={source.evidenceType} />
              </div>
              {source.snippet && (
                <p className="mt-2 text-xs text-muted-foreground">{source.snippet}</p>
              )}
              <p className="mt-2 text-[11px] text-muted-foreground">
                Discovered {formatTimestamp(source.retrievedAt)} · not fetched · not verified
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Full evidence panel (sources + report + risks + gaps + next actions)
// ---------------------------------------------------------------------------

export function ResearchEvidencePanel({ result }: { result: ResearchResult }) {
  const report = result.sourceResearch;
  const missingEvidence = result.signals
    .filter((s) => s.type === 'demand')
    .length === 0
    ? ['No demand indicators were produced by this research run.']
    : [];

  return (
    <div className="space-y-6">
      {/* Real-research run report */}
      {report && (
        <div
          className={cn(
            'rounded-xl border p-4 text-sm',
            report.status === 'OK'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : report.status === 'PARTIAL'
                ? 'border-amber-200 bg-amber-50 text-amber-900'
                : report.status === 'NOT_CONFIGURED'
                  ? 'border-sky-200 bg-sky-50 text-sky-900'
                  : 'border-red-200 bg-red-50 text-red-900',
          )}
          role="status"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-white/60 px-2 py-0.5 text-xs font-semibold">
              Real research: {report.status.replace(/_/g, ' ')}
            </span>
            {report.searchProviderId && (
              <span className="rounded-full bg-white/60 px-2 py-0.5 text-xs">
                provider: {report.searchProviderId}
              </span>
            )}
            <span className="text-xs opacity-80">at {formatTimestamp(report.ranAt)}</span>
          </div>
          <p className="mt-2">{report.reasoning}</p>
          {report.fetchErrors.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs opacity-90">
              {report.fetchErrors.slice(0, 5).map((err, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                  {err}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Sources with provenance */}
      <ResearchSourceList result={result} />

      {/* Confidence + AI/verified provenance summary */}
      <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold uppercase tracking-wide">Provenance summary:</span>
          <ProvenanceBadge type="VERIFIED_DATA" /> <span>fetched content ({result.sources.filter((s) => s.evidenceType === 'VERIFIED_DATA').length})</span>
          <ProvenanceBadge type="SEARCH_DISCOVERY" /> <span>search leads ({result.sources.filter((s) => s.evidenceType === 'SEARCH_DISCOVERY').length})</span>
          <ProvenanceBadge type="AI_INFERENCE" /> <span>AI interpretation (findings, signals, summary)</span>
        </div>
        <p className="mt-2">
          Overall confidence {(result.overallConfidence * 100).toFixed(0)}% reflects AI interpretation quality —{' '}
          <span className="font-medium text-foreground/80">it never upgrades any source to VERIFIED_DATA</span>. AI output
          cannot promote discovery into verified evidence; only fetched, validated pages carry that label.
        </p>
      </div>

      {/* Missing evidence */}
      {missingEvidence.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <h4 className="text-xs font-semibold uppercase tracking-wide">Missing evidence</h4>
          <ul className="mt-1.5 list-inside list-disc space-y-1">
            {missingEvidence.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
