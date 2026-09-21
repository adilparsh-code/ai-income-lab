'use client';

import { cn } from '@/lib/utils';

interface ScoreBreakdownItem {
  factor: string;
  label: string;
  rawScore: number;
  weight: number;
  weightedScore: number;
}

interface ScoreBreakdownProps {
  breakdown: ScoreBreakdownItem[];
  overallScore: number;
  isInvestable: boolean;
  warnings: string[];
  explanation: string;
}

export function ScoreBreakdown({ breakdown, overallScore, isInvestable, warnings, explanation }: ScoreBreakdownProps) {
  return (
    <div className="space-y-6">
      {/* Overall Score */}
      <div className="text-center">
        <div className={cn(
          'inline-flex items-center justify-center h-24 w-24 rounded-full border-4 text-3xl font-bold',
          overallScore >= 80 ? 'border-emerald-500 text-emerald-600 bg-emerald-50' :
          overallScore >= 60 ? 'border-blue-500 text-blue-600 bg-blue-50' :
          overallScore >= 40 ? 'border-amber-500 text-amber-600 bg-amber-50' :
          'border-red-500 text-red-600 bg-red-50'
        )}>
          {overallScore}
        </div>
        <p className="mt-2 text-sm font-medium">Overall Score</p>
        {!isInvestable && (
          <p className="mt-1 text-xs text-red-600 font-medium">⚠ Not investable</p>
        )}
      </div>

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="space-y-2">
          {warnings.map((warning, i) => (
            <div key={i} className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
              ⚠ {warning}
            </div>
          ))}
        </div>
      )}

      {/* Factor Breakdown */}
      <div className="space-y-3">
        <h4 className="text-sm font-semibold">Score Breakdown</h4>
        {breakdown.map((item) => (
          <div key={item.factor} className="space-y-1">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {item.label}
                <span className="text-xs ml-1">({Math.round(item.weight * 100)}%)</span>
              </span>
              <span className="font-medium">{item.rawScore}</span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className={cn(
                  'h-full rounded-full transition-all',
                  item.rawScore >= 80 ? 'bg-emerald-500' :
                  item.rawScore >= 60 ? 'bg-blue-500' :
                  item.rawScore >= 40 ? 'bg-amber-500' :
                  'bg-red-500'
                )}
                style={{ width: `${item.rawScore}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Explanation */}
      <div className="rounded-lg bg-muted/50 p-4">
        <h4 className="text-sm font-semibold mb-1">Analysis</h4>
        <p className="text-sm text-muted-foreground">{explanation}</p>
      </div>
    </div>
  );
}
