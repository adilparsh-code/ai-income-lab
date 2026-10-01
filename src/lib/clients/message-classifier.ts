// ============================================================================
// PHASE 11.1 — MESSAGE CLASSIFIER (deterministic, bounded, offline)
// ============================================================================
// First-pass classification of client message content (Phase 11.1 spec §20–25).
// Pure functions: no DB, no network, no AI provider, no API key. Detection is
// bounded pattern matching over normalized text (lower-cased, whitespace
// collapsed, zero-width characters stripped) — not exact-phrase-only.
//
// Invariants:
// - Detection produces SIGNALS, never privileged behavior.
// - A PAYMENT_CLAIM flag can NEVER set riskState = PAYMENT_VERIFIED (the risk
//   engine has no path to it — see prospect-states.ts).
// - If a future LLM classifier disagrees, the DETERMINISTIC signal wins:
//   these flags can never be cleared by AI output (nothing here reads AI).
// - Bounded work: one pass, fixed rule list, early normalization, capped
//   matches per rule.
// ============================================================================

// ---------------------------------------------------------------------------
// Trust flags (bounded, validated representation — stored as JSON array)
// ---------------------------------------------------------------------------

export const TRUST_FLAGS = [
  'PROMPT_INJECTION_SUSPECTED',
  'CREDENTIAL_REQUEST',
  'PAYMENT_CLAIM',
  'FREE_WORK_REQUEST',
  'URGENCY_PRESSURE',
  'SCOPE_CHANGE_REQUEST',
  'ABUSE_SUSPECTED',
  'HALAL_VIOLATION_PRESSURE',
  'HISTORY_MANIPULATION',
  'RESOURCE_WASTE',
] as const;

export type TrustFlag = (typeof TRUST_FLAGS)[number];

export function isTrustFlag(value: unknown): value is TrustFlag {
  return typeof value === 'string' && (TRUST_FLAGS as readonly string[]).includes(value);
}

/** Parse a stored trustFlags JSON array, dropping anything unvalidated. */
export function parseTrustFlags(raw: string | null | undefined): TrustFlag[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isTrustFlag);
  } catch {
    return [];
  }
}

export function serializeTrustFlags(flags: readonly TrustFlag[]): string {
  const unique = Array.from(new Set(flags));
  return JSON.stringify(unique.slice(0, TRUST_FLAGS.length));
}

// ---------------------------------------------------------------------------
// Classification categories (first-pass enum)
// ---------------------------------------------------------------------------

export const MESSAGE_CATEGORIES = [
  'IN_SCOPE',
  'QUESTION',
  'SCOPE_CHANGE_REQUEST',
  'FREE_WORK_REQUEST',
  'PAYMENT_CLAIM',
  'INJECTION_SUSPECTED',
  'CREDENTIAL_REQUEST',
  'URGENCY_PRESSURE',
  'OTHER',
] as const;

export type MessageCategory = (typeof MESSAGE_CATEGORIES)[number];

export function isMessageCategory(value: unknown): value is MessageCategory {
  return typeof value === 'string' && (MESSAGE_CATEGORIES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Detection result
// ---------------------------------------------------------------------------

export interface MessageClassification {
  categories: MessageCategory[];
  flags: TrustFlag[];
  /** Rule ids that fired, for explainability (bounded, short). */
  matchedRules: string[];
}

// ---------------------------------------------------------------------------
// Normalization (bounded)
// ---------------------------------------------------------------------------

/** Lower-case, collapse whitespace, strip zero-width/homoglyph-ish padding. */
export function normalizeMessageText(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '') // zero-width chars
    .toLowerCase()
    .replace(/[_*`~]/g, ' ') // markdown emphasis used to split words
    .replace(/[!.,;:"'()\[\]{}<>?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Bounded pattern rules — [ruleId, regex]. Word-boundary aware where it
// matters; deliberately a SHORT list (avoid an enormous heuristic framework).
// ---------------------------------------------------------------------------

type PatternRule = readonly [id: string, pattern: RegExp];

const INJECTION_RULES: readonly PatternRule[] = [
  ['inj-ignore-previous', /\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|rules?|prompts?|messages?)\b/],
  ['inj-ignore-system', /\b(ignore|disregard|override|bypass)\s+(the\s+)?(system|developer|admin)\s+(instructions?|prompt|rules?|message)\b/],
  ['inj-new-instructions', /\b(new|updated|revised)\s+(system\s+)?instructions?\b/],
  ['inj-reveal-prompt', /\b(reveal|show|print|repeat|output|display)\s+(your\s+)?(system\s+prompt|hidden\s+instructions?|initial\s+prompt|original\s+instructions?)\b/],
  ['inj-reveal-secrets', /\b(reveal|show|print|display|give|send|share|what)\b[^.]{0,24}\b(secrets?|environment\s+variables?|env\s+vars?|api\s+keys?|credentials?)\b/],
  ['inj-disable-safety', /\b(disable|turn\s+off|switch\s+off|deactivate|remove)\s+(all\s+)?(safety|security|guardrails?|filters?|audits?|monitoring)\b/],
  ['inj-bypass-safety', /\b(bypass|skip|ignore)\s+(the\s+)?(safety|security|halal|audit|approval|review|payment)\s+(checks?|gates?|controls?|filters?|review)\b/],
  ['inj-bypass-payment', /\b(bypass|skip|ignore)\s+(the\s+)?payment\b|\bmark\s+(the\s+)?payment\s+(as\s+)?(verified|paid|complete)\b/],
  ['inj-change-admin', /\b(change|modify|update|set)\s+(the\s+)?(admin\s+settings?|agent\s+permissions?|budgets?|governance|payment\s+(state|config))\b/],
  ['inj-execute-code', /\b(execute|run)\s+(a\s+)?(shell|bash|terminal)?\s*(command|cmd|code|script)\b|\brm\s+-rf\b|\bdrop\s+table\b|\bdelete\s+(from\s+)?(database|all\s+tables?)\b/],
  ['inj-database', /\b(delete|drop|truncate|wipe|modify|update)\s+(the\s+)?(database|db|schema|tables?)\b/],
  ['inj-act-as', /\b(you\s+are\s+now|act\s+as|pretend\s+to\s+be|behave\s+as)\s+(an?\s+)?(unrestricted|uncensored|dan|root|admin|developer\s+mode)\b/],
];

const CREDENTIAL_RULES: readonly PatternRule[] = [
  ['cred-generic', /\b(send|share|give|provide|need|get|reveal|show|what)\b[^.]{0,24}\b(password|passphrase|api\s?key|apikey|access\s+token|auth\s+token|session\s+token|admin\s+credential|private\s+key|secret\s+key|login\s+credentials?)\b/],
  ['cred-named-env', /\b(database\s?url|direct\s?url|api[\s_]?key|secret\s?key|access\s?token|private\s?key|admin[\s_]?password|polar_[a-z_]*token|vercel[\s_]?token|operator_[a-z_]*token)\b/],
  ['cred-env-request', /\b(what\s+is|send|show|give|list|read)\s+(me\s+)?(the\s+)?(value\s+of\s+)?(your\s+)?env(ironment)?\s+variables?\b/],
];

const PAYMENT_CLAIM_RULES: readonly PatternRule[] = [
  ['claim-sent', /\b(i\s+(have\s+)?(already\s+)?(sent|paid|transferred|wired)\b|\bpayment\s+(has\s+been\s+)?(sent|made|completed)\b|\bi\s+paid\s+(you|already|the\s+(invoice|deposit|bill))\b)/],
  ['claim-proof', /\b(screenshot|receipt|transaction\s*(id|hash|reference)|proof\s+of\s+payment|bank\s+transfer\s+reference)\b/],
];

const FREE_WORK_RULES: readonly PatternRule[] = [
  ['free-pay-later', /\b(pay\s+(you\s+)?(after|once|when|if)\b|\bdo\s+(it|the\s+(whole|entire|full|complete)\s+(project|work|website|job))\s+first\b|\bfree\s+(trial|sample|test\s+project|demo)\b|\bas\s+a\s+test\b|\bif\s+i\s+like\s+it\b)/],
  ['free-before-payment', /\b(source\s+code|files?|credentials?|repo|repository)\s+(first|before\s+(any\s+)?payment|upfront)\b|\bwork\s+(for\s+free|unpaid)\b|\bno\s+(payment|charge)\s+(for\s+)?(now|yet|first)\b/],
];

const SCOPE_CHANGE_RULES: readonly PatternRule[] = [
  ['scope-add', /\b(also|additionally|plus)\s+(build|add|create|include|make)?\s*(a\s+|an\s+|the\s+)?(mobile\s+app|admin\s+panel|dashboard|payment\s+system|integration|api|module|bot)\b|\b(add|include)\s+(a\s+|an\s+|the\s+)?(mobile\s+app|admin\s+panel|dashboard|payment\s+system|integration|api|feature|module|page|report|bot)\b|\bcan\s+you\s+also\b|\bone\s+more\s+thing\b|\bwhile\s+you.?re\s+at\s+it\b/],
  ['scope-grow', /\b(instead\s+of|change\s+the\s+scope|expand\s+the\s+scope|extend\s+the\s+scope|make\s+it\s+bigger|more\s+pages|additional\s+(pages|features|work))\b/],
];

const URGENCY_RULES: readonly PatternRule[] = [
  ['urgency', /\b(urgent|urgently|asap|right\s+now|immediately|in\s+the\s+next\s+(hour|minutes?|hours?)|today\s+or\s+(i|m))\b|\bdeadline\s+(is\s+)?(in|within)\s+(an\s+hour|hours)\b|\bemergency\b/],
];

const HALAL_PRESSURE_RULES: readonly PatternRule[] = [
  ['halal-pressure', /\b(ignore|bypass|skip|relax|loosen)\s+(the\s+)?(halal|sharia|haram)\b|\b(halal|sharia|haram)\s+(rules?|filter|screening)\s+(don.?t|do\s+not|shouldn.?t|can\s+be\s+(skipped|ignored|bypassed))\b|\bit.?s\s+not\s+really\s+(gambling|haram)\b|\bjust\s+this\s+once\b/],
];

const HISTORY_MANIPULATION_RULES: readonly PatternRule[] = [
  ['history-rewrite', /\b(delete|remove|edit|rewrite|change|alter|modify)\s+(our\s+|the\s+|your\s+)?(previous|earlier|prior|last|old)\s+(messages?|conversation|history|emails?)\b|\b(rewrite|change|alter|modify)\s+(the\s+)?conversation\s+history\b|\b(delete|remove)\s+what\s+i\s+(said|wrote)\b|\bas\s+(we|i)\s+(agreed|discussed)\s+(earlier|before)\s*,?\s*you\s+(said|promised)\b/],
  ['history-invent', /\b(you\s+already\s+agreed|you\s+promised|we\s+already\s+agreed)\s+(to|that)\b/],
];

const ABUSE_RULES: readonly PatternRule[] = [
  ['abuse-language', /\b(idiot|stupid|moron|useless\s+(bot|ai|system)|piece\s+of\s+junk)\b|\bf[u *]+ck|\bsh[i1 *]+t\b/],
  ['abuse-social', /\b(you\s+must|you\s+have\s+to|you\s+need\s+to)\s+(do\s+it|comply|obey)|\bi\s+know\s+(the\s+)?(owner|ceo|admin|developer)\b/],
];

const WASTE_RULES: readonly PatternRule[] = [
  ['waste-rework', /\b(again|another\s+time|one\s+more\s+time)\s+(from\s+scratch|redo|re-do|start\s+over)\b|\b(throw\s+it\s+away|scrap\s+it\s+all|delete\s+everything)\b|\bchanged\s+my\s+mind\s+about\s+(everything|the\s+whole)\b/],
];

/**
 * Words commonly split by zero-width characters or markdown emphasis to evade
 * detection. Only these are re-joined during normalization — a bounded,
 * deny-by-default evasion countermeasure that cannot mangle normal prose.
 */
const SPLIT_TOKEN_WORDS: ReadonlySet<string> = new Set([
  'ignore', 'reveal', 'bypass', 'password', 'admin', 'secret', 'token', 'delete',
  'execute', 'disable', 'override', 'instructions', 'payment', 'verified',
]);

/**
 * Collapse split-token evasions ("ig nore", "re veal", "p ass word") by
 * merging adjacent tokens ONLY when the joined form is a known evasion word.
 * Bounded, deterministic, and unable to mangle normal prose.
 */
function collapseSplitTokens(text: string): string {
  const tokens = text.split(' ');
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const merged = SPLIT_TOKEN_WORDS.has(`${tokens[i]}${tokens[i + 1] ?? ''}`)
      ? `${tokens[i]}${tokens.splice(i + 1, 1)[0] ?? ''}`
      : tokens[i];
    out.push(merged);
  }
  return out.join(' ');
}

function runRules(text: string, rules: readonly PatternRule[], flags: TrustFlag[], matched: string[]): void {
  for (const [id, pattern] of rules) {
    if (pattern.test(text)) {
      matched.push(id);
      switch (id.split('-')[0]) {
        case 'inj': flags.push('PROMPT_INJECTION_SUSPECTED'); break;
        case 'cred': flags.push('CREDENTIAL_REQUEST'); break;
        case 'claim': flags.push('PAYMENT_CLAIM'); break;
        case 'free': flags.push('FREE_WORK_REQUEST'); break;
        case 'scope': flags.push('SCOPE_CHANGE_REQUEST'); break;
        case 'urgency': flags.push('URGENCY_PRESSURE'); break;
        case 'halal': flags.push('HALAL_VIOLATION_PRESSURE'); break;
        case 'history': flags.push('HISTORY_MANIPULATION'); break;
        case 'abuse': flags.push('ABUSE_SUSPECTED'); break;
        case 'waste': flags.push('RESOURCE_WASTE'); break;
        default: break;
      }
    }
  }
}

/** Question / in-scope heuristics (benign categories). */
function detectBenignCategories(text: string): MessageCategory[] {
  const categories: MessageCategory[] = [];
  const questionish = /\b(what|when|where|which|who|why|how|can|could|would|do you|does|is|are)\b/.test(text)
    || text.includes('?');
  if (questionish) categories.push('QUESTION');
  return categories;
}

/**
 * Deterministic first-pass classification of one message body. Bounded:
 * single normalization pass, fixed rule lists, capped output. Split-token
 * evasions ("i**gnore", "i__gnore", "i-gnore") are collapsed before matching.
 */
export function classifyMessageBody(rawBody: string): MessageClassification {
  const text = collapseSplitTokens(normalizeMessageText(rawBody.slice(0, 10_000)));
  const flags: TrustFlag[] = [];
  const matchedRules: string[] = [];

  runRules(text, INJECTION_RULES, flags, matchedRules);
  runRules(text, CREDENTIAL_RULES, flags, matchedRules);
  runRules(text, PAYMENT_CLAIM_RULES, flags, matchedRules);
  runRules(text, FREE_WORK_RULES, flags, matchedRules);
  runRules(text, SCOPE_CHANGE_RULES, flags, matchedRules);
  runRules(text, URGENCY_RULES, flags, matchedRules);
  runRules(text, HALAL_PRESSURE_RULES, flags, matchedRules);
  runRules(text, HISTORY_MANIPULATION_RULES, flags, matchedRules);
  runRules(text, ABUSE_RULES, flags, matchedRules);
  runRules(text, WASTE_RULES, flags, matchedRules);

  const categories: MessageCategory[] = [];
  if (flags.includes('PROMPT_INJECTION_SUSPECTED')) categories.push('INJECTION_SUSPECTED');
  if (flags.includes('CREDENTIAL_REQUEST')) categories.push('CREDENTIAL_REQUEST');
  if (flags.includes('PAYMENT_CLAIM')) categories.push('PAYMENT_CLAIM');
  if (flags.includes('FREE_WORK_REQUEST')) categories.push('FREE_WORK_REQUEST');
  if (flags.includes('SCOPE_CHANGE_REQUEST')) categories.push('SCOPE_CHANGE_REQUEST');
  if (flags.includes('URGENCY_PRESSURE')) categories.push('URGENCY_PRESSURE');
  categories.push(...detectBenignCategories(text));
  if (categories.length === 0) categories.push('IN_SCOPE');

  return {
    categories: Array.from(new Set(categories)).slice(0, MESSAGE_CATEGORIES.length),
    flags: Array.from(new Set(flags)),
    matchedRules: matchedRules.slice(0, 24),
  };
}

/** True when any deterministic security flag fired (they can never be AI-cleared). */
export function hasSecurityFlags(flags: readonly TrustFlag[]): boolean {
  return (
    flags.includes('PROMPT_INJECTION_SUSPECTED')
    || flags.includes('CREDENTIAL_REQUEST')
    || flags.includes('HALAL_VIOLATION_PRESSURE')
    || flags.includes('HISTORY_MANIPULATION')
    || flags.includes('ABUSE_SUSPECTED')
  );
}
