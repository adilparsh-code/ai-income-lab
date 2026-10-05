import type { SectionFailureReason } from '@/lib/ops/dashboard-section';

interface SectionUnavailableProps {
  title: string;
  reason: SectionFailureReason;
}

// Rendered in place of a dashboard section whose loader failed, so one failing
// query degrades that section visibly instead of crashing the whole page.
export function SectionUnavailable({ title, reason }: SectionUnavailableProps) {
  return (
    <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
      <strong>{title} is unavailable right now.</strong>{' '}
      {reason === 'SCHEMA_OUT_OF_DATE'
        ? 'The database schema is behind the application’s migrations. An operator must apply the pending Prisma migrations.'
        : 'The data could not be loaded. Nothing is fabricated while it is down; see the server logs for details.'}
    </div>
  );
}
