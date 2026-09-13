'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createRevenue } from '@/actions/revenue';
import { Save, Loader2, X } from 'lucide-react';

interface RevenueFormProps {
  opportunities: Array<{ id: string; title: string }>;
  onSuccess?: () => void;
  onCancel?: () => void;
}

export function RevenueForm({ opportunities, onSuccess, onCancel }: RevenueFormProps) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const today = new Date().toISOString().split('T')[0];

  const [formData, setFormData] = useState({
    date: today,
    revenueSource: '',
    grossRevenue: 0,
    fees: 0,
    advertisingCost: 0,
    otherCosts: 0,
    currency: 'USD',
    referenceNote: '',
    opportunityId: '',
    productId: '',
  });

  const netRevenue =
    (Number(formData.grossRevenue) || 0) -
    ((Number(formData.fees) || 0) + (Number(formData.advertisingCost) || 0) + (Number(formData.otherCosts) || 0));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.revenueSource.trim()) {
      setError('Revenue source is required');
      return;
    }
    if (formData.grossRevenue < 0) {
      setError('Gross revenue cannot be negative');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await createRevenue({
        date: formData.date,
        revenueSource: formData.revenueSource,
        grossRevenue: Number(formData.grossRevenue) || 0,
        fees: Number(formData.fees) || 0,
        advertisingCost: Number(formData.advertisingCost) || 0,
        otherCosts: Number(formData.otherCosts) || 0,
        currency: formData.currency,
        referenceNote: formData.referenceNote,
        opportunityId: formData.opportunityId || null,
        productId: formData.productId || null,
      });

      if (onSuccess) {
        onSuccess();
      } else {
        router.push('/revenue');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to record revenue entry');
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6 rounded-xl border bg-card p-6 shadow-sm">
      <div className="flex items-center justify-between border-b pb-4">
        <div>
          <h2 className="text-lg font-semibold">Record Revenue Entry</h2>
          <p className="text-sm text-muted-foreground">Log real transaction data across income sources.</p>
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
        <div>
          <label className="block text-sm font-medium mb-1">Date *</label>
          <input
            type="date"
            required
            value={formData.date}
            onChange={(e) => setFormData((prev) => ({ ...prev, date: e.target.value }))}
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Revenue Source *</label>
          <input
            type="text"
            required
            value={formData.revenueSource}
            onChange={(e) => setFormData((prev) => ({ ...prev, revenueSource: e.target.value }))}
            placeholder="e.g., Amazon KDP, Etsy, Stripe, Gumroad"
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Gross Revenue ($) *</label>
          <input
            type="number"
            required
            min={0}
            step="any"
            value={formData.grossRevenue}
            onChange={(e) => setFormData((prev) => ({ ...prev, grossRevenue: parseFloat(e.target.value) || 0 }))}
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Platform Fees ($)</label>
          <input
            type="number"
            min={0}
            step="any"
            value={formData.fees}
            onChange={(e) => setFormData((prev) => ({ ...prev, fees: parseFloat(e.target.value) || 0 }))}
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Advertising Cost ($)</label>
          <input
            type="number"
            min={0}
            step="any"
            value={formData.advertisingCost}
            onChange={(e) => setFormData((prev) => ({ ...prev, advertisingCost: parseFloat(e.target.value) || 0 }))}
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Other Costs ($)</label>
          <input
            type="number"
            min={0}
            step="any"
            value={formData.otherCosts}
            onChange={(e) => setFormData((prev) => ({ ...prev, otherCosts: parseFloat(e.target.value) || 0 }))}
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
            {opportunities.map((opp) => (
              <option key={opp.id} value={opp.id}>
                {opp.title.replace('[SAMPLE] ', '')}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Currency</label>
          <input
            type="text"
            value={formData.currency}
            onChange={(e) => setFormData((prev) => ({ ...prev, currency: e.target.value }))}
            placeholder="USD"
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        <div className="sm:col-span-2">
          <label className="block text-sm font-medium mb-1">Notes / Reference ID</label>
          <input
            type="text"
            value={formData.referenceNote}
            onChange={(e) => setFormData((prev) => ({ ...prev, referenceNote: e.target.value }))}
            placeholder="e.g., Payout ID #9842, Q3 royalty statement"
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
      </div>

      {/* Net Revenue Preview */}
      <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-4 flex items-center justify-between">
        <span className="text-sm font-medium text-emerald-900">Calculated Net Revenue:</span>
        <span className={`text-xl font-bold ${netRevenue >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
          ${netRevenue.toFixed(2)} {formData.currency}
        </span>
      </div>

      <div className="flex items-center gap-3 pt-4 border-t">
        <button
          type="submit"
          disabled={isSubmitting}
          className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-emerald-700 disabled:opacity-50 transition-colors"
        >
          {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Record Entry
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