import { notFound } from 'next/navigation';
import { getOpportunity } from '@/actions/opportunities';
import { ScoreBreakdown } from '@/components/opportunities/score-breakdown';
import { StatusBadge } from '@/components/shared/status-badge';
import { HalalBadge } from '@/components/shared/halal-badge';
import { PageHeader } from '@/components/shared/page-header';
import Link from 'next/link';
import { ArrowLeft, Edit, Clock, AlertTriangle, Target, Users, Coins, BarChart3 } from 'lucide-react';
import { formatDate, formatCurrency } from '@/lib/utils';
import { DeleteOpportunityButton } from '@/components/opportunities/delete-button';

interface Props {
  params: Promise<{ id: string }>;
}

export default async function OpportunityDetailPage({ params }: Props) {
  const { id } = await params;
  const opportunity = await getOpportunity(id);

  if (!opportunity) {
    notFound();
  }

  const isSample = opportunity.confidenceLevel === 'SAMPLE_DATA';

  return (
    <div className="p-6 lg:p-8 space-y-8">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href="/opportunities" className="hover:text-foreground transition-colors flex items-center gap-1">
          <ArrowLeft className="h-4 w-4" />
          Back to Opportunities
        </Link>
      </div>

      <PageHeader
        title={opportunity.title.replace('[SAMPLE] ', '')}
        description={opportunity.category}
      >
        {isSample && (
          <span className="rounded bg-amber-100 px-2 py-1 text-xs font-medium text-amber-700">
            SAMPLE DATA
          </span>
        )}
        <Link
          href={`/opportunities/${id}/edit`}
          className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium hover:bg-accent transition-colors"
        >
          <Edit className="h-4 w-4" />
          Edit
        </Link>
        <DeleteOpportunityButton id={opportunity.id} title={opportunity.title} />
      </PageHeader>

      {/* Status badges */}
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge status={opportunity.status} />
        <HalalBadge status={opportunity.halalStatus} />
        <span className="text-sm text-muted-foreground">
          {opportunity.businessModel}
        </span>
      </div>

      <div className="grid gap-8 lg:grid-cols-3">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-6">
          {/* Details Grid */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border p-4">
              <div className="flex items-center gap-2 mb-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-medium">Target Audience</h3>
              </div>
              <p className="text-sm text-muted-foreground">{opportunity.targetAudience}</p>
            </div>
            <div className="rounded-lg border p-4">
              <div className="flex items-center gap-2 mb-2">
                <Target className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-medium">Problem Solved</h3>
              </div>
              <p className="text-sm text-muted-foreground">{opportunity.problemSolved}</p>
            </div>
            <div className="rounded-lg border p-4">
              <div className="flex items-center gap-2 mb-2">
                <Coins className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-medium">Monetization</h3>
              </div>
              <p className="text-sm text-muted-foreground">{opportunity.monetizationMethod}</p>
            </div>
            <div className="rounded-lg border p-4">
              <div className="flex items-center gap-2 mb-2">
                <BarChart3 className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-medium">Startup Cost</h3>
              </div>
              <p className="text-sm text-muted-foreground">
                {opportunity.estimatedStartupCost > 0
                  ? formatCurrency(opportunity.estimatedStartupCost)
                  : 'Not estimated'}
              </p>
            </div>
          </div>

          {/* Evidence */}
          {opportunity.evidenceNotes && (
            <div className="rounded-lg border p-4">
              <h3 className="text-sm font-semibold mb-2">Evidence & Source Notes</h3>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">{opportunity.evidenceNotes}</p>
            </div>
          )}

          {/* Risks */}
          {opportunity.risks && (
            <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-4">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                <h3 className="text-sm font-semibold text-amber-800">Risks</h3>
              </div>
              <p className="text-sm text-amber-700 whitespace-pre-wrap">{opportunity.risks}</p>
            </div>
          )}

          {/* Next Action */}
          {opportunity.nextAction && (
            <div className="rounded-lg border-2 border-indigo-200 bg-indigo-50/50 p-4">
              <h3 className="text-sm font-semibold text-indigo-800 mb-1">Next Action</h3>
              <p className="text-sm text-indigo-700">{opportunity.nextAction}</p>
            </div>
          )}

          {/* Timestamps */}
          <div className="flex items-center gap-6 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Created: {formatDate(opportunity.createdAt)}
            </span>
            <span>
              Updated: {formatDate(opportunity.updatedAt)}
            </span>
            {opportunity.lastReviewedAt && (
              <span>
                Last reviewed: {formatDate(opportunity.lastReviewedAt)}
              </span>
            )}
          </div>
        </div>

        {/* Score Breakdown Sidebar */}
        <div className="rounded-xl border bg-card p-6 shadow-sm h-fit">
          <h3 className="text-sm font-semibold mb-4">Opportunity Score</h3>
          <ScoreBreakdown
            breakdown={opportunity.scoreResult.breakdown}
            overallScore={opportunity.scoreResult.overallScore}
            isInvestable={opportunity.scoreResult.isInvestable}
            warnings={opportunity.scoreResult.warnings}
            explanation={opportunity.scoreResult.explanation}
          />
        </div>
      </div>
    </div>
  );
}
