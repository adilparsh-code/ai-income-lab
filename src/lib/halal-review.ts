// Pure helpers for the audited human halal review (no DB, no network).
//
// IMPORTANT: this is a COMPLIANCE WORKFLOW RECORD, not a religious ruling. The
// keyword screen is a conservative filter; a human reviewer may clear a
// REVIEW_REQUIRED result for one exact version of the opportunity text, and the
// system records who, when, why, and against which content. It never clears
// NOT_ALLOWED, and any later edit of the screened text voids the clearance.
import { createHash } from 'node:crypto';

export const MIN_REVIEW_NOTE_CHARS = 20;
export const MAX_REVIEW_NOTE_CHARS = 1000;

export interface ScreenedFields {
  title: string;
  problemSolved: string;
  category: string;
  businessModel: string;
  monetizationMethod: string;
  targetAudience: string;
}

/** Hash of the exact text the screen/reviewer saw. Any edit changes it. */
export function halalContentHash(f: ScreenedFields): string {
  return createHash('sha256')
    .update(JSON.stringify([f.title, f.problemSolved, f.category, f.businessModel, f.monetizationMethod, f.targetAudience]), 'utf8')
    .digest('hex');
}

export function validateReviewNote(note: unknown): { ok: true; note: string } | { ok: false; error: string } {
  if (typeof note !== 'string') return { ok: false, error: 'A written review note is required.' };
  const trimmed = note.trim();
  if (trimmed.length < MIN_REVIEW_NOTE_CHARS) {
    return { ok: false, error: `Review note must be at least ${MIN_REVIEW_NOTE_CHARS} characters explaining why the flagged terms are acceptable.` };
  }
  if (trimmed.length > MAX_REVIEW_NOTE_CHARS) {
    return { ok: false, error: `Review note must be at most ${MAX_REVIEW_NOTE_CHARS} characters.` };
  }
  return { ok: true, note: trimmed };
}

export type HalalDecisionInput = {
  existingStatus: string;
  screenStatus: string;
  requestedStatus: string | undefined;
  /** True only when a HalalReview clearing THIS exact content hash exists. */
  hasMatchingClearance: boolean;
};

const ORDER = ['HALAL', 'REVIEW_REQUIRED', 'NOT_ALLOWED'] as const;
const rank = (s: string) => Math.max(0, ORDER.indexOf(s as (typeof ORDER)[number]));

/**
 * Status after an edit. Rules (fail-closed):
 *  - NOT_ALLOWED is sticky and the screen can set it.
 *  - Nothing here can raise a status to HALAL except an existing human
 *    clearance for the unchanged content (recorded via recordHalalReview).
 *  - Callers may tighten (HALAL -> REVIEW_REQUIRED) but never loosen.
 * Throws when a caller asks to loosen; the dedicated review action is the only path.
 */
export function decideHalalStatusOnUpdate(i: HalalDecisionInput): string {
  if (i.requestedStatus !== undefined && !ORDER.includes(i.requestedStatus as (typeof ORDER)[number])) {
    throw new Error('Invalid halalStatus');
  }
  if (i.existingStatus === 'NOT_ALLOWED' || i.screenStatus === 'NOT_ALLOWED') return 'NOT_ALLOWED';
  if (i.requestedStatus !== undefined && rank(i.requestedStatus) < rank(i.existingStatus)) {
    throw new Error('halalStatus cannot be loosened by an edit; record an audited human review instead (recordHalalReview).');
  }
  let status = i.requestedStatus !== undefined ? i.requestedStatus : i.existingStatus;
  if (rank(i.screenStatus) > rank(status)) status = i.screenStatus;
  // A previously cleared REVIEW_REQUIRED stays HALAL only while the content is unchanged.
  if (status === 'HALAL' && i.screenStatus === 'REVIEW_REQUIRED' && !i.hasMatchingClearance) status = 'REVIEW_REQUIRED';
  return status;
}
