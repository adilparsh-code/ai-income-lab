'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useTransition } from 'react';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import { OPPORTUNITY_STATUSES, OPPORTUNITY_CATEGORIES, HALAL_STATUSES } from '@/lib/constants';

export function OpportunityFilters() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const search = searchParams.get('search') || '';
  const statuses = searchParams.getAll('status');
  const categories = searchParams.getAll('category');
  const halalFilters = searchParams.getAll('halal');
  const sortBy = searchParams.get('sortBy') || 'overallScore';
  const sortOrder = searchParams.get('sortOrder') || 'desc';

  const updateParams = useCallback((updates: Record<string, string | string[] | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    
    for (const [key, value] of Object.entries(updates)) {
      params.delete(key);
      if (value !== null) {
        if (Array.isArray(value)) {
          value.forEach(v => params.append(key, v));
        } else {
          params.set(key, value);
        }
      }
    }
    
    startTransition(() => {
      router.push(`/opportunities?${params.toString()}`);
    });
  }, [router, searchParams, startTransition]);

  const toggleFilter = (key: string, value: string, currentValues: string[]) => {
    const newValues = currentValues.includes(value)
      ? currentValues.filter(v => v !== value)
      : [...currentValues, value];
    updateParams({ [key]: newValues.length > 0 ? newValues : null });
  };

  const clearAllFilters = () => {
    startTransition(() => {
      router.push('/opportunities');
    });
  };

  const hasActiveFilters = search || statuses.length > 0 || categories.length > 0 || halalFilters.length > 0;

  return (
    <div className="space-y-4">
      {/* Search and Sort Row */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search opportunities..."
            value={search}
            onChange={(e) => updateParams({ search: e.target.value || null })}
            className="w-full rounded-lg border bg-background pl-9 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
        <select
          value={`${sortBy}-${sortOrder}`}
          onChange={(e) => {
            const [by, order] = e.target.value.split('-');
            updateParams({ sortBy: by, sortOrder: order });
          }}
          className="rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="overallScore-desc">Highest Score</option>
          <option value="overallScore-asc">Lowest Score</option>
          <option value="createdAt-desc">Newest First</option>
          <option value="createdAt-asc">Oldest First</option>
          <option value="title-asc">Name A-Z</option>
          <option value="title-desc">Name Z-A</option>
        </select>
      </div>

      {/* Filter Chips */}
      <div className="space-y-3">
        {/* Status */}
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">Status</p>
          <div className="flex flex-wrap gap-1.5">
            {OPPORTUNITY_STATUSES.map((status) => (
              <button
                key={status}
                onClick={() => toggleFilter('status', status, statuses)}
                className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                  statuses.includes(status)
                    ? 'bg-indigo-100 text-indigo-700 ring-1 ring-indigo-300'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
              >
                {status.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
        </div>

        {/* Category */}
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">Category</p>
          <div className="flex flex-wrap gap-1.5">
            {OPPORTUNITY_CATEGORIES.map((cat) => (
              <button
                key={cat}
                onClick={() => toggleFilter('category', cat, categories)}
                className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                  categories.includes(cat)
                    ? 'bg-indigo-100 text-indigo-700 ring-1 ring-indigo-300'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        {/* Halal Status */}
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">Halal Status</p>
          <div className="flex flex-wrap gap-1.5">
            {HALAL_STATUSES.map((status) => (
              <button
                key={status}
                onClick={() => toggleFilter('halal', status, halalFilters)}
                className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                  halalFilters.includes(status)
                    ? 'bg-indigo-100 text-indigo-700 ring-1 ring-indigo-300'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
              >
                {status.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Clear Filters */}
      {hasActiveFilters && (
        <button
          onClick={clearAllFilters}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="h-3 w-3" />
          Clear all filters
        </button>
      )}
    </div>
  );
}
