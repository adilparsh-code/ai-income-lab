import { NextBestAction as NextBestActionType } from '@/actions/dashboard';
import Link from 'next/link';
import { ArrowRight, Sparkles, Target } from 'lucide-react';

interface NextBestActionProps {
  action: NextBestActionType | null;
}

export function NextBestAction({ action }: NextBestActionProps) {
  if (!action) {
    return (
      <div className="rounded-xl border-2 border-dashed border-muted-foreground/25 bg-muted/30 p-8 text-center">
        <Sparkles className="h-8 w-8 mx-auto text-muted-foreground/50 mb-3" />
        <h3 className="text-lg font-semibold mb-1">No Recommendations Yet</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Add and score opportunities to get personalized next-action recommendations.
        </p>
        <Link
          href="/opportunities/new"
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90 transition-colors"
        >
          Add Your First Opportunity
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    );
  }

  return (
    <div className="rounded-xl border-2 border-indigo-200 bg-gradient-to-br from-indigo-50 to-blue-50 p-6 dark:from-indigo-950/30 dark:to-blue-950/30 dark:border-indigo-800">
      <div className="flex items-start gap-4">
        <div className="rounded-lg bg-indigo-100 p-2.5 dark:bg-indigo-900">
          <Target className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-sm font-semibold text-indigo-600 uppercase tracking-wide dark:text-indigo-400">
              Next Best Action
            </h3>
            <span className="inline-flex items-center rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300">
              Score: {action.score}/100
            </span>
          </div>
          <h2 className="text-xl font-bold mb-2">{action.action}</h2>
          <p className="text-sm text-muted-foreground mb-4">
            <span className="font-medium">Why:</span> {action.reason}
          </p>
          <div className="flex items-center gap-3">
            <Link
              href={`/opportunities/${action.opportunityId}`}
              className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-indigo-700 transition-colors"
            >
              Start Now
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href={`/opportunities/${action.opportunityId}`}
              className="text-sm text-indigo-600 hover:underline dark:text-indigo-400"
            >
              View opportunity details
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
