import Link from 'next/link';
import { StatusBadge } from '@/components/shared/status-badge';
import { HalalBadge } from '@/components/shared/halal-badge';
import { ScoreDisplay } from '@/components/shared/score-display';
import { ArrowRight, Clock } from 'lucide-react';
import { formatDate } from '@/lib/utils';

interface OpportunityCardProps {
  opportunity: {
    id: string;
    title: string;
    category: string;
    businessModel: string;
    targetAudience: string;
    status: string;
    halalStatus: string;
    overallScore: number;
    nextAction: string;
    confidenceLevel: string;
    createdAt: Date;
  };
}

export function OpportunityCard({ opportunity }: OpportunityCardProps) {
  const isSample = opportunity.confidenceLevel === 'SAMPLE_DATA';
  
  return (
    <div className="rounded-xl border bg-card shadow-sm hover:shadow-md transition-shadow">
      <div className="p-5">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              {isSample && (
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">SAMPLE</span>
              )}
              <span className="text-xs text-muted-foreground">{opportunity.category}</span>
            </div>
            <Link
              href={`/opportunities/${opportunity.id}`}
              className="text-base font-semibold hover:text-indigo-600 transition-colors line-clamp-2"
            >
              {opportunity.title.replace('[SAMPLE] ', '')}
            </Link>
          </div>
          <ScoreDisplay score={opportunity.overallScore} size="md" />
        </div>
        
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <StatusBadge status={opportunity.status} />
          <HalalBadge status={opportunity.halalStatus} />
          <span className="text-xs text-muted-foreground">{opportunity.businessModel}</span>
        </div>

        <p className="text-xs text-muted-foreground mb-3 line-clamp-1">
          Target: {opportunity.targetAudience}
        </p>

        {opportunity.nextAction && (
          <div className="rounded-lg bg-muted/50 p-2.5 mb-3">
            <p className="text-xs text-muted-foreground">
              <span className="font-medium">Next:</span> {opportunity.nextAction}
            </p>
          </div>
        )}

        <div className="flex items-center justify-between pt-3 border-t">
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            {formatDate(opportunity.createdAt)}
          </span>
          <Link
            href={`/opportunities/${opportunity.id}`}
            className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-800 transition-colors"
          >
            View details
            <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </div>
    </div>
  );
}
