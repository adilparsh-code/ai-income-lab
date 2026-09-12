'use client';

import { useState } from 'react';
import { updateExperiment } from '@/actions/experiments';
import { formatCurrency, formatDate } from '@/lib/utils';
import { FlaskConical, TrendingUp, Users, Target, CheckCircle2, AlertCircle, Edit, Trash2 } from 'lucide-react';
import Link from 'next/link';

interface ExperimentCardProps {
  experiment: {
    id: string;
    hypothesis: string;
    target: string;
    budget: number;
    startDate: Date | string | null;
    endDate: Date | string | null;
    expectedResult: string;
    actualResult: string;
    visitors: number;
    leads: number;
    clicks: number;
    sales: number;
    revenue: number;
    profit: number;
    conversionRate: number;
    decision: string | null;
    opportunity?: {
      id: string;
      title: string;
      halalStatus: string;
    } | null;
  };
  onDelete?: (id: string) => void;
}

export function ExperimentCard({ experiment, onDelete }: ExperimentCardProps) {
  const [isEditingMetrics, setIsEditingMetrics] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [metrics, setMetrics] = useState({
    visitors: experiment.visitors,
    leads: experiment.leads,
    clicks: experiment.clicks,
    sales: experiment.sales,
    revenue: experiment.revenue,
    profit: experiment.profit,
    actualResult: experiment.actualResult,
    decision: experiment.decision || '',
  });

  const handleUpdateMetrics = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      await updateExperiment({
        id: experiment.id,
        visitors: Number(metrics.visitors) || 0,
        leads: Number(metrics.leads) || 0,
        clicks: Number(metrics.clicks) || 0,
        sales: Number(metrics.sales) || 0,
        revenue: Number(metrics.revenue) || 0,
        profit: Number(metrics.profit) || 0,
        actualResult: metrics.actualResult,
        decision: (metrics.decision as any) || null,
      });
      setIsEditingMetrics(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update metrics');
    } finally {
      setIsSubmitting(false);
    }
  };

  const getDecisionBadge = (decision: string | null) => {
    switch (decision) {
      case 'SCALE':
        return <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">SCALE</span>;
      case 'ITERATE':
        return <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800">ITERATE</span>;
      case 'PAUSE':
        return <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">PAUSE</span>;
      case 'KILL':
        return <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">KILL</span>;
      default:
        return <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-700">RUNNING</span>;
    }
  };

  return (
    <div className="rounded-xl border bg-card p-6 shadow-sm space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <FlaskConical className="h-4 w-4 text-indigo-600" />
            <h3 className="font-semibold text-base leading-tight">{experiment.hypothesis}</h3>
            {getDecisionBadge(experiment.decision)}
          </div>
          {experiment.opportunity && (
            <p className="text-xs text-muted-foreground">
              Linked to Opportunity:{' '}
              <Link href={`/opportunities/${experiment.opportunity.id}`} className="text-indigo-600 hover:underline">
                {experiment.opportunity.title.replace('[SAMPLE] ', '')}
              </Link>
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIsEditingMetrics(!isEditingMetrics)}
            className="rounded p-1.5 hover:bg-accent text-muted-foreground"
            title="Update Experiment Metrics"
          >
            <Edit className="h-4 w-4" />
          </button>
          {onDelete && (
            <button
              type="button"
              onClick={() => onDelete(experiment.id)}
              className="rounded p-1.5 hover:bg-red-50 text-red-600"
              title="Delete Experiment"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Target & Dates */}
      <div className="grid gap-2 sm:grid-cols-3 text-xs text-muted-foreground border-y py-2">
        <div>
          <span className="font-medium text-foreground">Target:</span> {experiment.target || 'N/A'}
        </div>
        <div>
          <span className="font-medium text-foreground">Budget:</span> {formatCurrency(experiment.budget)}
        </div>
        <div>
          <span className="font-medium text-foreground">Dates:</span>{' '}
          {experiment.startDate ? formatDate(experiment.startDate) : 'Not set'}
          {experiment.endDate ? ` - ${formatDate(experiment.endDate)}` : ''}
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-muted/30 rounded-lg p-3 text-center">
        <div>
          <p className="text-[10px] text-muted-foreground uppercase font-semibold">Visitors</p>
          <p className="text-lg font-bold">{experiment.visitors.toLocaleString()}</p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground uppercase font-semibold">Sales</p>
          <p className="text-lg font-bold">{experiment.sales.toLocaleString()}</p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground uppercase font-semibold">Conv. Rate</p>
          <p className="text-lg font-bold text-indigo-600">{experiment.conversionRate.toFixed(1)}%</p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground uppercase font-semibold">Net Profit</p>
          <p className={`text-lg font-bold ${experiment.profit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
            {formatCurrency(experiment.profit)}
          </p>
        </div>
      </div>

      {/* Outcome text */}
      {experiment.expectedResult && (
        <div className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Expected:</span> {experiment.expectedResult}
        </div>
      )}

      {/* Inline Edit Metrics Form */}
      {isEditingMetrics && (
        <form onSubmit={handleUpdateMetrics} className="border-t pt-4 space-y-3 bg-accent/20 p-4 rounded-lg">
          <h4 className="text-xs font-semibold uppercase text-muted-foreground">Log Metric Updates & Decision</h4>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-[11px] font-medium mb-1">Visitors</label>
              <input
                type="number"
                min={0}
                value={metrics.visitors}
                onChange={(e) => setMetrics({ ...metrics, visitors: parseInt(e.target.value) || 0 })}
                className="w-full rounded border px-2 py-1 text-xs"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium mb-1">Leads</label>
              <input
                type="number"
                min={0}
                value={metrics.leads}
                onChange={(e) => setMetrics({ ...metrics, leads: parseInt(e.target.value) || 0 })}
                className="w-full rounded border px-2 py-1 text-xs"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium mb-1">Clicks</label>
              <input
                type="number"
                min={0}
                value={metrics.clicks}
                onChange={(e) => setMetrics({ ...metrics, clicks: parseInt(e.target.value) || 0 })}
                className="w-full rounded border px-2 py-1 text-xs"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium mb-1">Sales</label>
              <input
                type="number"
                min={0}
                value={metrics.sales}
                onChange={(e) => setMetrics({ ...metrics, sales: parseInt(e.target.value) || 0 })}
                className="w-full rounded border px-2 py-1 text-xs"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium mb-1">Revenue ($)</label>
              <input
                type="number"
                min={0}
                step="any"
                value={metrics.revenue}
                onChange={(e) => setMetrics({ ...metrics, revenue: parseFloat(e.target.value) || 0 })}
                className="w-full rounded border px-2 py-1 text-xs"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium mb-1">Profit ($)</label>
              <input
                type="number"
                step="any"
                value={metrics.profit}
                onChange={(e) => setMetrics({ ...metrics, profit: parseFloat(e.target.value) || 0 })}
                className="w-full rounded border px-2 py-1 text-xs"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-medium mb-1">Decision</label>
              <select
                value={metrics.decision}
                onChange={(e) => setMetrics({ ...metrics, decision: e.target.value })}
                className="w-full rounded border px-2 py-1 text-xs"
              >
                <option value="">RUNNING (No Decision)</option>
                <option value="SCALE">SCALE (Success)</option>
                <option value="ITERATE">ITERATE (Pivot/Adjust)</option>
                <option value="PAUSE">PAUSE (Hold)</option>
                <option value="KILL">KILL (Abandon)</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-medium mb-1">Actual Result Notes</label>
              <input
                type="text"
                value={metrics.actualResult}
                onChange={(e) => setMetrics({ ...metrics, actualResult: e.target.value })}
                placeholder="Observed learnings..."
                className="w-full rounded border px-2 py-1 text-xs"
              />
            </div>
          </div>

          <div className="flex items-center gap-2 pt-2">
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {isSubmitting ? 'Saving...' : 'Save Metrics'}
            </button>
            <button
              type="button"
              onClick={() => setIsEditingMetrics(false)}
              className="rounded border px-3 py-1 text-xs font-medium hover:bg-accent"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
