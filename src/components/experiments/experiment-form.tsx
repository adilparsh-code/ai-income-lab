'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createExperiment } from '@/actions/experiments';
import { Save, Loader2, X } from 'lucide-react';

interface ExperimentFormProps {
  opportunities: Array<{ id: string; title: string; halalStatus: string }>;
  defaultOpportunityId?: string;
  onSuccess?: () => void;
  onCancel?: () => void;
}

export function ExperimentForm({ opportunities, defaultOpportunityId, onSuccess, onCancel }: ExperimentFormProps) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filter out NOT_ALLOWED opportunities for experiment linkage if necessary, or show badge
  const validOpportunities = opportunities.filter((o) => o.halalStatus !== 'NOT_ALLOWED');

  const [formData, setFormData] = useState({
    hypothesis: '',
    target: '',
    budget: 0,
    startDate: '',
    endDate: '',
    expectedResult: '',
    opportunityId: defaultOpportunityId || (validOpportunities.length > 0 ? validOpportunities[0].id : ''),
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.hypothesis.trim()) {
      setError('Hypothesis is required');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await createExperiment({
        hypothesis: formData.hypothesis,
        target: formData.target,
        budget: Number(formData.budget) || 0,
        startDate: formData.startDate || null,
        endDate: formData.endDate || null,
        expectedResult: formData.expectedResult,
        opportunityId: formData.opportunityId || null,
      });
      if (onSuccess) {
        onSuccess();
      } else {
        router.push('/experiments');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create experiment');
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6 rounded-xl border bg-card p-6 shadow-sm">
      <div className="flex items-center justify-between border-b pb-4">
        <div>
          <h2 className="text-lg font-semibold">New Experiment</h2>
          <p className="text-sm text-muted-foreground">Test a business hypothesis with measurable metrics.</p>
        </div>
        {onCancel && (
          <button type="button" onClick={onCancel} className="rounded p-1 hover:bg-accent text-muted-foreground">
            <X className="h-5 w-5" />
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="block text-sm font-medium mb-1">Hypothesis *</label>
          <input
            type="text"
            required
            value={formData.hypothesis}
            onChange={(e) => setFormData((prev) => ({ ...prev, hypothesis: e.target.value }))}
            placeholder="e.g., If we launch a 20-page kids coloring book on Etsy, we will generate 50 visits in week 1."
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Linked Opportunity</label>
          <select
            value={formData.opportunityId}
            onChange={(e) => setFormData((prev) => ({ ...prev, opportunityId: e.target.value }))}
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="">None / Standalone</option>
            {validOpportunities.map((opp) => (
              <option key={opp.id} value={opp.id}>
                {opp.title.replace('[SAMPLE] ', '')} ({opp.halalStatus})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Target Channel / Audience</label>
          <input
            type="text"
            value={formData.target}
            onChange={(e) => setFormData((prev) => ({ ...prev, target: e.target.value }))}
            placeholder="e.g., Etsy Search, Pinterest Ads"
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Budget (USD)</label>
          <input
            type="number"
            min={0}
            step="any"
            value={formData.budget}
            onChange={(e) => setFormData((prev) => ({ ...prev, budget: parseFloat(e.target.value) || 0 }))}
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Expected Outcome</label>
          <input
            type="text"
            value={formData.expectedResult}
            onChange={(e) => setFormData((prev) => ({ ...prev, expectedResult: e.target.value }))}
            placeholder="e.g., 5 sales ($50 gross revenue)"
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Start Date</label>
          <input
            type="date"
            value={formData.startDate}
            onChange={(e) => setFormData((prev) => ({ ...prev, startDate: e.target.value }))}
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">End Date</label>
          <input
            type="date"
            value={formData.endDate}
            onChange={(e) => setFormData((prev) => ({ ...prev, endDate: e.target.value }))}
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
      </div>

      <div className="flex items-center gap-3 pt-4 border-t">
        <button
          type="submit"
          disabled={isSubmitting}
          className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-indigo-700 disabled:opacity-50 transition-colors"
        >
          {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Create Experiment
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center gap-1 rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent transition-colors"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
