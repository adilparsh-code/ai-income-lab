// ============================================================================
// PHASE 11.3 — OUTREACH SAFETY + TRUTHFUL AI IDENTITY (pure)
// ============================================================================
// Two hard rules live here, enforced in code rather than policy:
//
// 1. TRUTHFUL IDENTITY (docs/phase-11-design.md §14). One business identity
//    constant. The system never impersonates the operator, never claims to be
//    human, and — critically — NEVER LIES when asked directly whether it is AI.
//    Deceptive identity is prohibited outright, so there is no code path that
//    can produce an impersonating reply.
//
// 2. BOUNDED, NON-SPAM OUTREACH (§22). No bulk unsolicited messaging, no fake
//    testimonials, no fake scarcity, no fabricated portfolio claims, no
//    manipulative sales copy, no people-search enrichment. Opt-out suppresses
//    future contact unconditionally. First contact is human-gated.
//
// Pure module: no DB, no network, no AI provider.
// ============================================================================

// ---------------------------------------------------------------------------
// Truthful identity
// ---------------------------------------------------------------------------

/** The single business identity used in any client-facing communication. */
export const BUSINESS_IDENTITY = 'AI-assisted business operator';

export const IDENTITY_DISCLOSURE = 'AI-assisted business operator';

/**
 * Patterns that ask directly whether the sender is an AI / bot / human. The
 * reply to ANY of these is a truthful disclosure — never deflection, never
 * "I'm a real person", never evasion.
 */
export const DIRECT_AI_QUESTIONS: readonly RegExp[] = [
  /\bare\s+you\s+(an?\s+)?(ai|bot|robot|human|real|machine|automated)/i,
  /\b(is\s+this|are\s+you)\s+(a\s+)?(real\s+)?(person|human|man|woman|bot|ai|automated)/i,
  /\bwho\s+are\s+you\b/i,
  /\bare\s+you\s+using\s+(an?\s+)?(ai|chatgpt|gpt|claude|llm|automation)/i,
  /\bdo\s+you\s+use\s+artificial\s+intelligence\b/i,
  /\bis\s+this\s+(a\s+)?(real|human)\b/i,
  /\bchat\s*bot\b.*\?\s*$/i,
];

/** True when the message asks, directly, whether the sender is human or AI. */
export function asksDirectlyAboutAiIdentity(message: string): boolean {
  if (typeof message !== 'string' || message.trim().length === 0) return false;
  return DIRECT_AI_QUESTIONS.some((pattern) => pattern.test(message));
}

/**
 * Compose the truthful reply to a direct AI-identity question.
 *
 * The returned copy MUST disclose AI involvement and must never claim to be
 * human. It is composed from fixed, honest statements only — no improvisation,
 * no persona invention.
 */
export function composeTruthfulIdentityReply(options: { businessName?: string } = {}): string {
  const name = typeof options.businessName === 'string' && options.businessName.trim().length > 0
    ? options.businessName.trim().slice(0, 120)
    : null;
  return [
    'Yes — you are speaking with an AI-assisted business operator.',
    name ? `This business (${name}) uses AI tooling to help prepare and deliver work.` : 'This business uses AI tooling to help prepare and deliver work.',
    'Everything you are sent is reviewed against the agreed scope before it counts as a commitment.',
    'A human is accountable for decisions, payments, and anything we agree to.',
  ].join(' ');
}

/** Assert that outgoing copy is truthful about identity. Used before any send. */
export function assertTruthfulIdentity(copy: string): { ok: true } | { ok: false; reason: string } {
  if (typeof copy !== 'string' || copy.trim().length === 0) {
    return { ok: false, reason: 'Outgoing copy is empty.' };
  }
  // A claim of human identity in a first-person system message is impersonation.
  if (/\b(i\s+am|i'm)\s+(a\s+)?(real\s+)?(human\s+)?(person|man|woman)\b/i.test(copy)) {
    return { ok: false, reason: 'Impersonation: the copy claims a human identity. This system never claims to be human.' };
  }
  if (/\b(my\s+|our\s+)?(team|staff|employees?|colleagues|people)\s+(are|is|will|can)\s+(here\s+)?(eager\s+|ready\s+|happy\s+|always\s+)?to\s+help\b/i.test(copy)) {
    return { ok: false, reason: 'Impersonation: the copy invents a human staff team that does not exist.' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Forbidden marketing claims
// ---------------------------------------------------------------------------

/**
 * Claims this system must never make. Each entry is a deceptive practice the
 * architecture explicitly prohibits (docs/phase-11-design.md §22, §7).
 */
export const FORBIDDEN_CLAIM_PATTERNS: readonly { id: string; pattern: RegExp }[] = [
  { id: 'fake-testimonial', pattern: /\b(trusted\s+by|as\s+seen\s+on|loved\s+by)\s+[\d,]+\+?\s*(clients?|customers?|businesses|users?|companies|students?|schools?)/i },
  { id: 'fake-rating', pattern: /\b\d(\.\d)?\s*[- ]?star\s+(rated|reviews?|rating)/i },
  { id: 'fake-portfolio', pattern: /\b(our\s+)?(previous|recent|past)\s+(clients?|projects?|work)\s+(include|are|were)\b/i },
  { id: 'fake-count', pattern: /\b\d[\d,]*\+?\s+(successful\s+)?(projects|deliveries|sales|orders)\s+(completed|delivered|shipped)\b/i },
  { id: 'fake-scarcity', pattern: /\b(only\s+\d+\s+(slots?|spots?|places?)|limited\s+time|hurry|act\s+now|last\s+chance|running\s+out\s+of)\b/i },
  { id: 'pressure-coercion', pattern: /\b(you\s+(have\s+no\s+choice|must\s+act|will\s+regret)|don'?t\s+(miss|think)|last\s+opportunity)\b/i },
  { id: 'false-guarantee', pattern: /\b(guaranteed?\s+(income|profit|results?|success|ranking|traffic|sales)|risk[- ]free\s+(income|investment|returns?))\b/i },
  { id: 'misleading-stat', pattern: /\b(up\s+to\s+\d+%\s+(more|higher|profit)|typically\s+\d+x\s+(more|better|profit))\b/i },
  { id: 'impersonation', pattern: /\b(i\s+am|i'?m)\s+(a\s+)?(the\s+)?(owner|founder|ceo|developer|designer|artist|employee)\b/i },
  { id: 'fake-experience', pattern: /\b(\d+\+?\s+years\s+of\s+(experience|industry)|industry\s+leading|award[- ]winning)\b/i },
  { id: 'deceptive-urgency-payment', pattern: /\b(pay\s+(us\s+)?(immediately|right\s+now)\s+(or|before)|wire\s+funds?\s+(first|before))/i },
];

export type OutreachViolation = { id: string; matched: string };

/** Scan outgoing copy for every prohibited claim. All matches are reported. */
export function findForbiddenClaims(copy: string): OutreachViolation[] {
  if (typeof copy !== 'string' || copy.length === 0) return [];
  const violations: OutreachViolation[] = [];
  for (const { id, pattern } of FORBIDDEN_CLAIM_PATTERNS) {
    const match = pattern.exec(copy);
    if (match) violations.push({ id, matched: match[0].slice(0, 120) });
  }
  return violations;
}

export type CopyVerdict =
  | { ok: true; violations: [] }
  | { ok: false; violations: OutreachViolation[]; reason: string };

/**
 * Full pre-send content gate: truthful identity AND no deceptive claims.
 * A single violation refuses the send.
 */
export function screenOutreachCopy(copy: string): CopyVerdict {
  const identity = assertTruthfulIdentity(copy);
  if (!identity.ok) return { ok: false, violations: [{ id: 'impersonation', matched: 'human-identity claim' }], reason: identity.reason };
  const violations = findForbiddenClaims(copy);
  if (violations.length > 0) {
    return {
      ok: false,
      violations,
      reason: `Outreach copy contains ${violations.length} prohibited claim(s): ${violations.map((v) => v.id).join(', ')}.`,
    };
  }
  return { ok: true, violations: [] };
}

// ---------------------------------------------------------------------------
// Bounded outreach
// ---------------------------------------------------------------------------

/** Hard caps. Outreach is reviewable and small by construction. */
export const OUTREACH_LIMITS = {
  /** Total contacts per prospect, ever. */
  maxContactsPerProspect: 3,
  /** Contacts in a rolling window per prospect. */
  maxContactsPerWindowDays: 30,
  /** Global outbound messages per day across the whole system. */
  maxGlobalSendsPerDay: 50,
  /** First contact always requires an explicit human approval reference. */
  requireHumanApprovalForFirstContact: true,
} as const;

export type OutreachEligibility =
  | { ok: true; warnings: string[] }
  | { ok: false; reason: string };

/**
 * Decide whether a prospect may be contacted right now. Every refusal is
 * explicit and terminal for that attempt — nothing here silently downgrades to
 * "send anyway".
 */
export function evaluateOutreachEligibility(input: {
  optedOut: boolean;
  suppressionReason?: string | null;
  lifecycleState: string;
  contactAttempts: number;
  lastContactedAt: Date | null;
  /** Human approval reference for FIRST contact. */
  contactApprovalRef?: string | null;
  now?: Date;
}): OutreachEligibility {
  // Opt-out wins over everything, unconditionally.
  if (input.optedOut) {
    return {
      ok: false,
      reason: `Prospect has opted out${input.suppressionReason ? ` (${input.suppressionReason})` : ''}; no outreach may be sent.`,
    };
  }
  // Only a qualified prospect may be contacted, and only through the approved
  // first-contact gate — NEW → CONTACTED is forbidden by Phase 11.1.
  if (input.lifecycleState === 'NEW' || input.lifecycleState === 'UNVERIFIED') {
    return { ok: false, reason: `Prospect lifecycle ${input.lifecycleState} is not contactable; it must be QUALIFIED first.` };
  }
  if (input.lifecycleState === 'BLOCKED' || input.lifecycleState === 'LOST') {
    return { ok: false, reason: `Prospect lifecycle ${input.lifecycleState} prohibits contact.` };
  }
  if (input.contactAttempts >= OUTREACH_LIMITS.maxContactsPerProspect) {
    return {
      ok: false,
      reason: `Per-prospect contact cap reached (${OUTREACH_LIMITS.maxContactsPerProspect}); no further outreach may be sent.`,
    };
  }
  const now = input.now ?? new Date();
  if (input.lastContactedAt) {
    const daysSince = (now.getTime() - input.lastContactedAt.getTime()) / 86_400_000;
    if (daysSince < OUTREACH_LIMITS.maxContactsPerWindowDays) {
      return {
        ok: false,
        reason: `Prospect was contacted ${Math.max(0, Math.round(daysSince))} day(s) ago; the ${OUTREACH_LIMITS.maxContactsPerWindowDays}-day contact window has not elapsed.`,
      };
    }
  }
  if (input.contactAttempts === 0 && OUTREACH_LIMITS.requireHumanApprovalForFirstContact) {
    if (typeof input.contactApprovalRef !== 'string' || input.contactApprovalRef.trim().length === 0) {
      return {
        ok: false,
        reason: 'First contact requires an explicit human approval reference (outreach-approval gate). No approval, no send.',
      };
    }
  }
  return { ok: true, warnings: [] };
}

/**
 * Prohibited data sources. This system uses business-level contact data only:
 * no scraping of private or personal data, no people-search enrichment, no
 * purchased lists, no credential material.
 */
export const PROHIBITED_DATA_SOURCES: readonly string[] = [
  'people-search',
  'people finder',
  'data broker',
  'purchased list',
  'scraped personal profiles',
  'private social data',
  'credential material',
  'email harvesting',
];

/** True when a discovery source names a prohibited data source. */
export function isProhibitedDataSource(source: string): boolean {
  // Unknown or empty provenance is treated as prohibited: absence of a source
  // is not evidence of a lawful one.
  if (typeof source !== 'string' || source.trim().length === 0) return true;
  const normalized = source.toLowerCase();
  return PROHIBITED_DATA_SOURCES.some((term) => normalized.includes(term));
}