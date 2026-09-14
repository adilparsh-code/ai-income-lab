import Link from 'next/link';
import { StatusBadge } from '@/components/shared/status-badge';
import { HalalBadge } from '@/components/shared/halal-badge';
import { ScoreDisplay } from '@/components/shared/score-display';
import { ArrowRight } from 'lucide-react';

interface Opportunity {
  id: string;
  title: string;
  category: string;
  status: string;
  halalStatus: string;
  overallScore: number;
  nextAction: string;
}

interface TopOpportunitiesProps {
  opportunities: Opportunity[];
}

export function TopOpportunities({ opportunities }: TopOpportunitiesProps) {
  if (opportunities.length === 0) {
    return (
      <div className="rounded-xl border bg-card p-6 shadow-sm">
        <h3 className="text-sm font-semibold mb-4">Top Opportunities</h3>
        <p className="text-sm text-muted-foreground text-center py-8">
          No opportunities yet. Create your first one!
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card p-6 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold">Top Opportunities</h3>
        <Link href="/opportunities" className="text-xs text-indigo-600 hover:underline flex items-center gap-1">
          View all <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      <div className="space-y-3">
        {opportunities.map((opp) => (
          <Link
            key={opp.id}
            href={`/opportunities/${opp.id}`}
            className="flex items-center gap-3 rounded-lg border p-3 hover:bg-accent/50 transition-colors"
          >
            <ScoreDisplay score={opp.overallScore} size="sm" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{opp.title.replace('[SAMPLE] ', '')}</p>
              <p className="text-xs text-muted-foreground truncate">{opp.category}</p>
            </div>
            <div className="hidden sm:flex items-center gap-2">
              <StatusBadge status={opp.status} />
              <HalalBadge status={opp.halalStatus} showIcon={false} />
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
