import { OpportunityForm } from '@/components/opportunities/opportunity-form';
import { PageHeader } from '@/components/shared/page-header';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

export default function NewOpportunityPage() {
  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href="/opportunities" className="hover:text-foreground transition-colors flex items-center gap-1">
          <ArrowLeft className="h-4 w-4" />
          Back to Opportunities
        </Link>
      </div>

      <PageHeader
        title="New Opportunity"
        description="Add a new business opportunity for evaluation."
      />

      <OpportunityForm mode="create" />
    </div>
  );
}
