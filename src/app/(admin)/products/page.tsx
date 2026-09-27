import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { Package } from 'lucide-react';

export default function ProductsPage() {
  return (
    <div className="p-6 lg:p-8 space-y-6">
      <PageHeader
        title="Products"
        description="Create, manage, and track your digital products."
      />

      <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-800 inline-flex items-center gap-2">
        <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold">PHASE 2</span>
        Coming soon — Product management will be available after opportunities are fully set up.
      </div>

      <EmptyState
        icon={Package}
        title="Product Factory"
        description="This section will let you create and manage coloring books, drawing books, activity books, worksheets, workbooks, printable PDFs, teacher resources, digital tools, affiliate content sites, and SaaS products. Each product links to an opportunity and tracks status from IDEA through PUBLISHED to EARNING."
      />
    </div>
  );
}
