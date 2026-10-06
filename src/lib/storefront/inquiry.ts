// ============================================================================
// STOREFRONT INQUIRY VALIDATION (pure) — the public intake contract.
// ============================================================================
// A purchase request from the storefront is UNTRUSTED INPUT. This module
// bounds and shape-checks it before anything touches the database:
//   - displayName / email / message are bounded and shape-checked;
//   - requestId is the caller's idempotency key (8..64 of [A-Za-z0-9_-]);
//   - `company` is a honeypot field: bots that fill it are accepted silently
//     and nothing is written (the caller drops the submission).
// No database access, no I/O — unit-testable in isolation.
// ============================================================================

export const MAX_STORE_INQUIRY_NAME = 200;
export const MAX_STORE_INQUIRY_EMAIL = 320;
export const MAX_STORE_INQUIRY_MESSAGE = 2_000;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REQUEST_ID_SHAPE = /^[A-Za-z0-9_-]{8,64}$/;
// Control characters (except newline/tab) are rejected, never silently stripped.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

export interface StoreInquiryValue {
  offerId: string;
  displayName: string;
  email: string;
  message: string;
  requestId: string;
  /** Non-empty when the honeypot was filled → caller must drop silently. */
  honeypot: string;
}

export type StoreInquiryValidation =
  | { ok: true; value: StoreInquiryValue }
  | { ok: false; error: string };

function fail(error: string): StoreInquiryValidation {
  return { ok: false, error };
}

export function validateStoreInquiry(raw: unknown): StoreInquiryValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail('Request body must be a JSON object.');
  }
  const input = raw as Record<string, unknown>;

  // Honeypot: detect first so a trapped bot never gets a validation lecture.
  const honeypot = typeof input.company === 'string' ? input.company.trim().slice(0, 300) : '';

  if (typeof input.offerId !== 'string' || input.offerId.trim().length === 0 || input.offerId.length > 128) {
    return fail('offerId is required (max 128 chars).');
  }

  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
  if (displayName.length === 0 || displayName.length > MAX_STORE_INQUIRY_NAME) {
    return fail(`Name is required (max ${MAX_STORE_INQUIRY_NAME} chars).`);
  }
  if (CONTROL_CHARS.test(displayName)) return fail('Name contains invalid characters.');

  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (email.length === 0 || email.length > MAX_STORE_INQUIRY_EMAIL || !EMAIL_SHAPE.test(email)) {
    return fail('A valid email address is required so we can fulfil your request.');
  }

  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (message.length === 0 || message.length > MAX_STORE_INQUIRY_MESSAGE) {
    return fail(`Message is required (max ${MAX_STORE_INQUIRY_MESSAGE} chars).`);
  }
  if (CONTROL_CHARS.test(message)) return fail('Message contains invalid characters.');

  const requestId = typeof input.requestId === 'string' ? input.requestId : '';
  if (!REQUEST_ID_SHAPE.test(requestId)) {
    return fail('requestId must be 8-64 characters of letters, digits, "-" or "_".');
  }

  return {
    ok: true,
    value: {
      offerId: input.offerId.trim(),
      displayName,
      email,
      message,
      requestId,
      honeypot,
    },
  };
}
