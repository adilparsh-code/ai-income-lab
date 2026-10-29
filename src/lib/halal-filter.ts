import { type HalalStatus } from './constants';

interface HalalScreeningResult {
  status: HalalStatus;
  reasons: string[];
  flaggedKeywords: string[];
}

// ---------------------------------------------------------------------------
// Matching model
// ---------------------------------------------------------------------------
// Input is normalised (NFKC, zero-width/combining marks stripped, common
// Cyrillic/Greek look-alikes folded to Latin, punctuation -> spaces) and terms
// are matched on WORD BOUNDARIES with simple inflections (s/es/ed/ing). This
// removes the old substring false positives ("ham" in "Hamilton"/"Shampoo")
// and the trivial evasions (Cyrillic look-alike letters, zero-width joiners,
// "g a m b l i n g"). It is still a keyword screen, NOT a religious authority:
// anything it misses must be caught by the human review step.

// Keywords and categories that trigger NOT_ALLOWED
const NOT_ALLOWED_KEYWORDS = [
  'gambling', 'gamble', 'casino', 'betting', 'sports bet', 'wager', 'wagering', 'sportsbook', 'bookmaker',
  'poker', 'slot machine', 'lottery', 'binary options', 'binary option',
  'adult content', 'pornography', 'porn', 'nsfw', 'onlyfans', 'sexual', 'escort', 'xxx',
  'fraud', 'scam', 'fake reviews', 'fake testimonials',
  'piracy', 'pirated', 'cracked software', 'torrent',
  'counterfeit', 'trademark abuse',
  'pyramid scheme', 'ponzi', 'mlm scheme',
  'deceptive advertising', 'clickbait scam',
  'plagiarism', 'stolen content',
];

const NOT_ALLOWED_CATEGORIES = [
  'gambling', 'betting', 'adult entertainment', 'casino',
  'fraud services', 'counterfeit goods',
];

// Keywords and categories that trigger REVIEW_REQUIRED
const REVIEW_REQUIRED_KEYWORDS = [
  'interest-based', 'conventional finance', 'loan', 'mortgage', 'riba',
  'payday', 'cash advance', 'buy now pay later', 'credit card',
  'insurance', 'conventional banking',
  'alcohol', 'wine', 'beer', 'spirits', 'brewery',
  'tobacco', 'cigarette', 'vaping', 'vape',
  'pork', 'ham', 'bacon',
  'entertainment', 'music streaming', 'dating',
  'tarot', 'astrology', 'horoscope', 'fortune telling', 'psychic',
  'cryptocurrency', 'crypto trading', 'forex',
  'stock trading', 'day trading',
  'dropshipping', // can be legitimate but often deceptive
];

const REVIEW_REQUIRED_CATEGORIES = [
  'finance', 'investment', 'trading', 'entertainment',
  'food & beverage', 'health supplements',
];

// Look-alike letters commonly used to dodge keyword filters.
const HOMOGLYPHS: Record<string, string> = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'у': 'y', 'і': 'i', 'ј': 'j', 'ѕ': 's',
  'к': 'k', 'м': 'm', 'н': 'h', 'т': 't', 'в': 'b', 'ɡ': 'g', 'ԁ': 'd', 'ӏ': 'l',
  'α': 'a', 'ε': 'e', 'ο': 'o', 'ρ': 'p', 'ν': 'v', 'ι': 'i', 'κ': 'k', 'τ': 't', 'υ': 'u', 'χ': 'x',
};

function normalizeForScreening(input: string): string {
  const folded = input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200B-\u200F\u2060-\u2064\uFEFF\u00AD]/g, '') // zero-width + soft hyphen
    .normalize('NFD')
    .replace(/\p{M}+/gu, '') // combining marks
    .replace(/[^\u0000-\u007F]/g, (ch) => HOMOGLYPHS[ch] ?? ch);
  return folded.replace(/[^a-z0-9]+/g, ' ').trim();
}

function escapeRegExp(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildMatcher(keyword: string): RegExp {
  const k = escapeRegExp(normalizeForScreening(keyword)).replace(/ /g, '\\s+');
  return new RegExp(`(?<![a-z0-9])${k}(?:s|es|ed|ing)?(?![a-z0-9])`);
}

const NOT_ALLOWED_MATCHERS = NOT_ALLOWED_KEYWORDS.map((k) => ({ k, re: buildMatcher(k) }));
const REVIEW_MATCHERS = REVIEW_REQUIRED_KEYWORDS.map((k) => ({ k, re: buildMatcher(k) }));

/**
 * Long prohibited terms are also checked against the text with ALL separators
 * removed, which catches "g a m b l i n g" / "g.a.m.b.l.i.n.g". Restricted to
 * long terms (>= 7 chars) to keep accidental cross-word matches negligible.
 */
const COMPACT_TERMS = NOT_ALLOWED_KEYWORDS
  .map((k) => ({ k, compact: normalizeForScreening(k).replace(/ /g, '') }))
  .filter((t) => t.compact.length >= 7);

export function screenForHalalCompliance(
  title: string,
  description: string,
  category: string,
  businessModel: string,
  monetizationMethod: string,
  extraText: string = '',
): HalalScreeningResult {
  const text = normalizeForScreening(
    [title, description, category, businessModel, monetizationMethod, extraText].join(' '),
  );
  const compactText = text.replace(/ /g, '');
  const categoryNorm = normalizeForScreening(category);

  const prohibitedHits: string[] = [];
  const prohibitedReasons: string[] = [];

  for (const { k, re } of NOT_ALLOWED_MATCHERS) {
    if (re.test(text)) {
      prohibitedHits.push(k);
      prohibitedReasons.push(`Contains prohibited term: "${k}"`);
    }
  }
  for (const { k, compact } of COMPACT_TERMS) {
    if (!prohibitedHits.includes(k) && compactText.includes(compact)) {
      prohibitedHits.push(k);
      prohibitedReasons.push(`Contains prohibited term (obfuscated): "${k}"`);
    }
  }
  for (const cat of NOT_ALLOWED_CATEGORIES) {
    if (categoryNorm.includes(normalizeForScreening(cat))) {
      prohibitedHits.push(cat);
      prohibitedReasons.push(`Category "${category}" is not permitted`);
    }
  }

  if (prohibitedHits.length > 0) {
    return { status: 'NOT_ALLOWED', reasons: prohibitedReasons, flaggedKeywords: prohibitedHits };
  }

  const reviewHits: string[] = [];
  const reviewReasons: string[] = [];
  for (const { k, re } of REVIEW_MATCHERS) {
    if (re.test(text)) {
      reviewHits.push(k);
      reviewReasons.push(`Contains term requiring review: "${k}"`);
    }
  }
  for (const cat of REVIEW_REQUIRED_CATEGORIES) {
    if (categoryNorm.includes(normalizeForScreening(cat))) {
      reviewHits.push(cat);
      reviewReasons.push(`Category "${category}" requires human review for halal compliance`);
    }
  }

  if (reviewHits.length > 0) {
    return { status: 'REVIEW_REQUIRED', reasons: reviewReasons, flaggedKeywords: reviewHits };
  }

  return {
    status: 'HALAL',
    reasons: ['No compliance concerns identified. This is a screening tool, not a religious authority.'],
    flaggedKeywords: [],
  };
}

export function getHalalStatusDescription(status: HalalStatus): string {
  switch (status) {
    case 'HALAL':
      return 'No concerns identified by automated keyword screening, or cleared by a recorded human review. This is a compliance workflow, not a religious ruling.';
    case 'REVIEW_REQUIRED':
      return 'This opportunity contains elements that require human review for halal compliance. The system is a screening tool, not a religious authority.';
    case 'NOT_ALLOWED':
      return 'This opportunity has been flagged as impermissible. It cannot receive an investment recommendation.';
  }
}
