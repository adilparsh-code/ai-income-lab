import { notFound } from 'next/navigation';
import { getOpportunity } from '@/actions/opportunities';
import { OpportunityForm } from '@/components/opportunities/opportunity-form';
import { PageHeader } from '@/components/shared/page-header';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

interface Props {
  params: Promise<{ id: string }>;
}

export default async function EditOpportunityPage({ params }: Props) {
  const { id } = await params;
  const opportunity = await getOpportunity(id);

  if (!opportunity) {
    notFound();
  }

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href={`/opportunities/${id}`} className="hover:text-foreground transition-colors flex items-center gap-1">
          <ArrowLeft className="h-4 w-4" />
          Back to Opportunity
        </Link>
      </div>

      <PageHeader
        title="Edit Opportunity"
        description={opportunity.title}
      />

      <OpportunityForm
        mode="edit"
        opportunity={{
          id: opportunity.id,
          title: opportunity.title,
          category: opportunity.category,
          businessModel: opportunity.businessModel,
          targetAudience: opportunity.targetAudience,
          problemSolved: opportunity.problemSolved,
          monetizationMethod: opportunity.monetizationMethod,
          estimatedStartupCost: opportunity.estimatedStartupCost,
          demandScore: opportunity.demandScore,
          competitionScore: opportunity.competitionScore,
          commercialIntentScore: opportunity.commercialIntentScore,
          automationScore: opportunity.automationScore,
          differentiationScore: opportunity.differentiationScore,
          monetizationScore: opportunity.monetizationScore,
          halalConfidenceScore: opportunity.halalConfidenceScore,
          halalStatus: opportunity.halalStatus,
          confidenceLevel: opportunity.confidenceLevel,
          status: opportunity.status,
          evidenceNotes: opportunity.evidenceNotes,
          risks: opportunity.risks,
          nextAction: opportunity.nextAction,
        }}
      />
    </div>
  );
}
