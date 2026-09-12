'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createOpportunity, updateOpportunity } from '@/actions/opportunities';
import { OPPORTUNITY_CATEGORIES, BUSINESS_MODELS, OPPORTUNITY_STATUSES, HALAL_STATUSES, CONFIDENCE_LEVELS, SCORING_LABELS, SCORING_WEIGHTS } from '@/lib/constants';
import { ArrowLeft, Save, Loader2 } from 'lucide-react';
import Link from 'next/link';

interface OpportunityFormProps {
  opportunity?: {
    id: string;
    title: string;
    category: string;
    businessModel: string;
    targetAudience: string;
    problemSolved: string;
    monetizationMethod: string;
    estimatedStartupCost: number;
    demandScore: number;
    competitionScore: number;
    commercialIntentScore: number;
    automationScore: number;
    differentiationScore: number;
    monetizationScore: number;
    halalConfidenceScore: number;
    halalStatus: string;
    confidenceLevel: string;
    status: string;
    evidenceNotes: string;
    risks: string;
    nextAction: string;
  };
  mode: 'create' | 'edit';
}

export function OpportunityForm({ opportunity, mode }: OpportunityFormProps) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    title: opportunity?.title || '',
    category: opportunity?.category || 'Digital Products',
    businessModel: opportunity?.businessModel || 'Direct Sales',
    targetAudience: opportunity?.targetAudience || '',
    problemSolved: opportunity?.problemSolved || '',
    monetizationMethod: opportunity?.monetizationMethod || '',
    estimatedStartupCost: opportunity?.estimatedStartupCost || 0,
    demandScore: opportunity?.demandScore || 50,
    competitionScore: opportunity?.competitionScore || 50,
    commercialIntentScore: opportunity?.commercialIntentScore || 50,
    automationScore: opportunity?.automationScore || 50,
    differentiationScore: opportunity?.differentiationScore || 50,
    monetizationScore: opportunity?.monetizationScore || 50,
    halalConfidenceScore: opportunity?.halalConfidenceScore || 100,
    halalStatus: opportunity?.halalStatus || 'HALAL',
    confidenceLevel: opportunity?.confidenceLevel || 'MEDIUM',
    status: opportunity?.status || 'IDEA',
    evidenceNotes: opportunity?.evidenceNotes || '',
    risks: opportunity?.risks || '',
    nextAction: opportunity?.nextAction || '',
  });

  const handleChange = (field: string, value: string | number) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      if (mode === 'create') {
        await createOpportunity(formData);
      } else if (opportunity) {
        await updateOpportunity(opportunity.id, formData);
      }
      router.push('/opportunities');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setIsSubmitting(false);
    }
  };

  // Preview estimated score
  const estimatedScore = Math.round(
    formData.demandScore * 0.20 +
    formData.commercialIntentScore * 0.20 +
    formData.competitionScore * 0.15 +
    (formData.estimatedStartupCost <= 0 ? 95 : formData.estimatedStartupCost <= 100 ? 85 : formData.estimatedStartupCost <= 500 ? 65 : 40) * 0.10 +
    formData.automationScore * 0.10 +
    formData.differentiationScore * 0.10 +
    formData.monetizationScore * 0.10 +
    formData.halalConfidenceScore * 0.05
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-8 max-w-4xl">
      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-sm text-red-800">
          {error}
        </div>
      )}

      {/* Basic Information */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Basic Information</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="block text-sm font-medium mb-1">Title *</label>
            <input
              type="text"
              required
              value={formData.title}
              onChange={(e) => handleChange('title', e.target.value)}
              placeholder="e.g., Children's Coloring Books"
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Category</label>
            <select
              value={formData.category}
              onChange={(e) => handleChange('category', e.target.value)}
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {OPPORTUNITY_CATEGORIES.map(cat => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Business Model</label>
            <select
              value={formData.businessModel}
              onChange={(e) => handleChange('businessModel', e.target.value)}
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {BUSINESS_MODELS.map(model => (
                <option key={model} value={model}>{model}</option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className="block text-sm font-medium mb-1">Target Audience *</label>
            <input
              type="text"
              required
              value={formData.targetAudience}
              onChange={(e) => handleChange('targetAudience', e.target.value)}
              placeholder="e.g., Parents of children aged 3-8"
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-sm font-medium mb-1">Problem Solved *</label>
            <textarea
              required
              value={formData.problemSolved}
              onChange={(e) => handleChange('problemSolved', e.target.value)}
              placeholder="What problem does this solve for the target audience?"
              rows={2}
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Monetization Method *</label>
            <input
              type="text"
              required
              value={formData.monetizationMethod}
              onChange={(e) => handleChange('monetizationMethod', e.target.value)}
              placeholder="e.g., Amazon KDP sales, affiliate commission"
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Estimated Startup Cost (USD)</label>
            <input
              type="number"
              min={0}
              value={formData.estimatedStartupCost}
              onChange={(e) => handleChange('estimatedStartupCost', parseFloat(e.target.value) || 0)}
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
        </div>
      </section>

      {/* Scores */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Opportunity Scores</h2>
          <div className="text-right">
            <p className="text-sm text-muted-foreground">Estimated Score</p>
            <p className={`text-2xl font-bold ${
              estimatedScore >= 80 ? 'text-emerald-600' :
              estimatedScore >= 60 ? 'text-blue-600' :
              estimatedScore >= 40 ? 'text-amber-600' : 'text-red-600'
            }`}>{estimatedScore}/100</p>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {[
            { key: 'demandScore', label: 'Demand Score', weight: '20%' },
            { key: 'commercialIntentScore', label: 'Commercial Intent', weight: '20%' },
            { key: 'competitionScore', label: 'Competition Opportunity', weight: '15%', hint: 'Higher = less competition' },
            { key: 'automationScore', label: 'Automation Potential', weight: '10%' },
            { key: 'differentiationScore', label: 'Differentiation', weight: '10%' },
            { key: 'monetizationScore', label: 'Monetization Strength', weight: '10%' },
            { key: 'halalConfidenceScore', label: 'Halal/Compliance Confidence', weight: '5%' },
          ].map(({ key, label, weight, hint }) => (
            <div key={key}>
              <label className="flex items-center justify-between text-sm font-medium mb-1">
                <span>{label}</span>
                <span className="text-xs text-muted-foreground">{weight} • {(formData as any)[key]}/100</span>
              </label>
              {hint && <p className="text-xs text-muted-foreground mb-1">{hint}</p>}
              <input
                type="range"
                min={0}
                max={100}
                value={(formData as any)[key]}
                onChange={(e) => handleChange(key, parseInt(e.target.value))}
                className="w-full accent-indigo-600"
              />
            </div>
          ))}
        </div>
      </section>

      {/* Status & Compliance */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Status & Compliance</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="block text-sm font-medium mb-1">Status</label>
            <select
              value={formData.status}
              onChange={(e) => handleChange('status', e.target.value)}
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {OPPORTUNITY_STATUSES.map(s => (
                <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Halal Status</label>
            <select
              value={formData.halalStatus}
              onChange={(e) => handleChange('halalStatus', e.target.value)}
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {HALAL_STATUSES.map(s => (
                <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Confidence Level</label>
            <select
              value={formData.confidenceLevel}
              onChange={(e) => handleChange('confidenceLevel', e.target.value)}
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {CONFIDENCE_LEVELS.map(c => (
                <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {/* Evidence & Notes */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Evidence & Notes</h2>
        <div className="grid gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Evidence / Source Notes</label>
            <textarea
              value={formData.evidenceNotes}
              onChange={(e) => handleChange('evidenceNotes', e.target.value)}
              placeholder="What evidence supports this opportunity? Mark clearly if data is estimated vs verified."
              rows={3}
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Risks</label>
            <textarea
              value={formData.risks}
              onChange={(e) => handleChange('risks', e.target.value)}
              placeholder="What are the main risks?"
              rows={2}
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Next Action</label>
            <input
              type="text"
              value={formData.nextAction}
              onChange={(e) => handleChange('nextAction', e.target.value)}
              placeholder="What's the next step for this opportunity?"
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
        </div>
      </section>

      {/* Actions */}
      <div className="flex items-center gap-3 pt-4 border-t">
        <button
          type="submit"
          disabled={isSubmitting}
          className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-indigo-700 disabled:opacity-50 transition-colors"
        >
          {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {mode === 'create' ? 'Create Opportunity' : 'Save Changes'}
        </button>
        <Link
          href="/opportunities"
          className="inline-flex items-center gap-1 rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Cancel
        </Link>
      </div>
    </form>
  );
}
