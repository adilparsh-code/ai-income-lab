// Dashboard section loading with deliberate, per-section failure handling.
//
// The dashboard composes many independent loaders. Without isolation, one
// failing query (for example a Prisma P2022 "column does not exist" when the
// production database is behind prisma/migrations) rejects the page's
// Promise.all and crashes the whole Server Component render. Each section is
// instead loaded through loadDashboardSection(): failures are logged
// server-side (redacted; never secrets) with a classification, and the page
// renders an explicit "unavailable" state for that section only.
//
// Next.js control-flow errors (redirect, notFound, dynamic-usage bailouts) are
// rethrown untouched so framework behavior is never swallowed.

import { unstable_rethrow } from 'next/navigation';
import { logger } from '@/lib/server-log';

export type SectionFailureReason = 'SCHEMA_OUT_OF_DATE' | 'LOAD_FAILED';

export type SectionResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: SectionFailureReason };

// P2021: table does not exist. P2022: column does not exist. Both mean the
// connected database schema does not match the generated Prisma client.
const SCHEMA_MISMATCH_CODES = new Set(['P2021', 'P2022']);

function prismaErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^P\d{4}$/.test(code) ? code : null;
}

export function classifySectionFailure(error: unknown): SectionFailureReason {
  const code = prismaErrorCode(error);
  return code && SCHEMA_MISMATCH_CODES.has(code) ? 'SCHEMA_OUT_OF_DATE' : 'LOAD_FAILED';
}

export async function loadDashboardSection<T>(
  section: string,
  load: () => Promise<T>,
): Promise<SectionResult<T>> {
  try {
    return { ok: true, data: await load() };
  } catch (error) {
    unstable_rethrow(error);
    const reason = classifySectionFailure(error);
    logger.error(`Dashboard section "${section}" failed to load`, error, {
      section,
      reason,
      code: prismaErrorCode(error),
      ...(reason === 'SCHEMA_OUT_OF_DATE'
        ? { hint: 'Database schema is behind prisma/migrations; apply pending migrations (prisma7 migrate deploy).' }
        : {}),
    });
    return { ok: false, reason };
  }
}
