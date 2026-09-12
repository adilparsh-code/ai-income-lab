import { type HalalStatus } from './constants';

interface HalalScreeningResult {
  status: HalalStatus;
  reasons: string[];
  flaggedKeywords: string[];
}

// Keywords and categories that trigger NOT_ALLOWED
const NOT_ALLOWED_KEYWORDS = [
  'gambling', 'casino', 'betting', 'poker', 'slot machine', 'lottery',
  'adult content', 'pornography', 'sexual', 'escort', 'xxx',
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
  'interest-based', 'conventional finance', 'loan', 'mortgage',
  'insurance', 'conventional banking',
  'alcohol', 'wine', 'beer', 'spirits', 'brewery',
  'tobacco', 'cigarette', 'vaping',
  'pork', 'ham', 'bacon',
  'entertainment', 'music streaming', 'dating',
  'cryptocurrency', 'crypto trading', 'forex',
  'stock trading', 'day trading',
  'dropshipping', // can be legitimate but often deceptive
];

const REVIEW_REQUIRED_CATEGORIES = [
  'finance', 'investment', 'trading', 'entertainment',
  'food & beverage', 'health supplements',
];

export function screenForHalalCompliance(
  title: string,
  description: string,
  category: string,
  businessModel: string,
  monetizationMethod: string
): HalalScreeningResult {
  const textToCheck = [
    title, description, category, businessModel, monetizationMethod
  ].join(' ').toLowerCase();

  const flaggedKeywords: string[] = [];
  const reasons: string[] = [];

  // Check NOT_ALLOWED keywords
  for (const keyword of NOT_ALLOWED_KEYWORDS) {
    if (textToCheck.includes(keyword.toLowerCase())) {
      flaggedKeywords.push(keyword);
      reasons.push(`Contains prohibited term: "${keyword}"`);
    }
  }

  // Check NOT_ALLOWED categories
  const categoryLower = category.toLowerCase();
  for (const cat of NOT_ALLOWED_CATEGORIES) {
    if (categoryLower.includes(cat)) {
      flaggedKeywords.push(cat);
      reasons.push(`Category "${category}" is not permitted`);
    }
  }

  if (flaggedKeywords.length > 0 && reasons.some(r => 
    NOT_ALLOWED_KEYWORDS.some(k => r.includes(k)) ||
    NOT_ALLOWED_CATEGORIES.some(c => r.includes(c))
  )) {
    return {
      status: 'NOT_ALLOWED',
      reasons,
      flaggedKeywords,
    };
  }

  // Check REVIEW_REQUIRED keywords
  for (const keyword of REVIEW_REQUIRED_KEYWORDS) {
    if (textToCheck.includes(keyword.toLowerCase())) {
      flaggedKeywords.push(keyword);
      reasons.push(`Contains term requiring review: "${keyword}"`);
    }
  }

  // Check REVIEW_REQUIRED categories
  for (const cat of REVIEW_REQUIRED_CATEGORIES) {
    if (categoryLower.includes(cat)) {
      flaggedKeywords.push(cat);
      reasons.push(`Category "${category}" requires human review for halal compliance`);
    }
  }

  if (flaggedKeywords.length > 0) {
    return {
      status: 'REVIEW_REQUIRED',
      reasons,
      flaggedKeywords,
    };
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
      return 'No compliance concerns identified by automated screening.';
    case 'REVIEW_REQUIRED':
      return 'This opportunity contains elements that require human review for halal compliance. The system is a screening tool, not a religious authority.';
    case 'NOT_ALLOWED':
      return 'This opportunity has been flagged as impermissible. It cannot receive an investment recommendation.';
  }
}
