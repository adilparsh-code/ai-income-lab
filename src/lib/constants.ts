// Opportunity statuses
export const OPPORTUNITY_STATUSES = [
  'IDEA', 'RESEARCHING', 'VALIDATING', 'VALIDATED', 'BUILDING',
  'PUBLISHED', 'EARNING', 'SCALING', 'PAUSED', 'REJECTED'
] as const;
export type OpportunityStatus = typeof OPPORTUNITY_STATUSES[number];

// Product statuses
export const PRODUCT_STATUSES = [
  'IDEA', 'DRAFTING', 'DESIGNING', 'QA', 'READY',
  'PUBLISHED', 'EARNING', 'IMPROVING', 'ARCHIVED'
] as const;
export type ProductStatus = typeof PRODUCT_STATUSES[number];

// Experiment decisions
export const EXPERIMENT_DECISIONS = ['SCALE', 'ITERATE', 'PAUSE', 'KILL'] as const;
export type ExperimentDecision = typeof EXPERIMENT_DECISIONS[number];

// Halal statuses
export const HALAL_STATUSES = ['HALAL', 'REVIEW_REQUIRED', 'NOT_ALLOWED'] as const;
export type HalalStatus = typeof HALAL_STATUSES[number];

// Opportunity categories
export const OPPORTUNITY_CATEGORIES = [
  'Digital Products', "Children's Books", 'Educational Content',
  'Teacher Resources', 'Affiliate', 'SaaS/Tool', 'Printables',
  'Online Course', 'Other'
] as const;
export type OpportunityCategory = typeof OPPORTUNITY_CATEGORIES[number];

// Business models
export const BUSINESS_MODELS = [
  'Direct Sales', 'Affiliate Commission', 'Subscription', 'Freemium',
  'Advertising', 'Licensing', 'Marketplace', 'Service', 'Other'
] as const;
export type BusinessModel = typeof BUSINESS_MODELS[number];

// Confidence levels
export const CONFIDENCE_LEVELS = [
  'VERY_HIGH', 'HIGH', 'MEDIUM', 'LOW', 'VERY_LOW', 'SAMPLE_DATA'
] as const;
export type ConfidenceLevel = typeof CONFIDENCE_LEVELS[number];

// Revenue sources
export const REVENUE_SOURCES = [
  'Product Sale', 'Affiliate Commission', 'Subscription',
  'Ad Revenue', 'Service Fee', 'License Fee', 'Other'
] as const;
export type RevenueSource = typeof REVENUE_SOURCES[number];

// Content types
export const CONTENT_TYPES = [
  'Product Description', 'Buying Guide', 'Comparison Page',
  'Educational Article', 'FAQ', 'Landing Page', 'SEO Content',
  'Meta Description', 'Other'
] as const;
export type ContentType = typeof CONTENT_TYPES[number];

// Product types
export const PRODUCT_TYPES = [
  'Coloring Book', 'Drawing Book', 'Activity Book', 'Worksheet',
  'Workbook', 'Printable PDF', 'Teacher Resource', 'Digital Tool',
  'Affiliate Content Site', 'SaaS Product', 'Other'
] as const;
export type ProductType = typeof PRODUCT_TYPES[number];

// Agent types
export const AGENT_TYPES = [
  'Research', 'Validation', 'Product', 'Affiliate', 'SEO',
  'QA', 'Analytics', 'Growth', 'Business Manager'
] as const;
export type AgentType = typeof AGENT_TYPES[number];

// Evidence types for agent logs
export const EVIDENCE_TYPES = ['AI_INFERENCE', 'VERIFIED_DATA', 'USER_ENTERED'] as const;
export type EvidenceType = typeof EVIDENCE_TYPES[number];

// Scoring weights
export const SCORING_WEIGHTS = {
  demand: 0.20,
  commercialIntent: 0.20,
  competition: 0.15,
  startupCost: 0.10,
  automation: 0.10,
  differentiation: 0.10,
  monetization: 0.10,
  halalCompliance: 0.05,
} as const;

export const SCORING_LABELS: Record<keyof typeof SCORING_WEIGHTS, string> = {
  demand: 'Demand',
  commercialIntent: 'Commercial Intent',
  competition: 'Competition Opportunity',
  startupCost: 'Startup Cost',
  automation: 'Automation Potential',
  differentiation: 'Differentiation',
  monetization: 'Monetization Strength',
  halalCompliance: 'Halal/Compliance',
};

// Status colors for UI
export const STATUS_COLORS: Record<string, string> = {
  IDEA: 'bg-slate-100 text-slate-700',
  RESEARCHING: 'bg-blue-100 text-blue-700',
  VALIDATING: 'bg-purple-100 text-purple-700',
  VALIDATED: 'bg-indigo-100 text-indigo-700',
  BUILDING: 'bg-amber-100 text-amber-700',
  PUBLISHED: 'bg-green-100 text-green-700',
  EARNING: 'bg-emerald-100 text-emerald-700',
  SCALING: 'bg-teal-100 text-teal-700',
  PAUSED: 'bg-gray-100 text-gray-600',
  REJECTED: 'bg-red-100 text-red-700',
  DRAFTING: 'bg-blue-100 text-blue-700',
  DESIGNING: 'bg-violet-100 text-violet-700',
  QA: 'bg-orange-100 text-orange-700',
  READY: 'bg-cyan-100 text-cyan-700',
  IMPROVING: 'bg-amber-100 text-amber-700',
  ARCHIVED: 'bg-gray-100 text-gray-500',
};

export const HALAL_COLORS: Record<string, string> = {
  HALAL: 'bg-green-100 text-green-700 border-green-200',
  REVIEW_REQUIRED: 'bg-amber-100 text-amber-700 border-amber-200',
  NOT_ALLOWED: 'bg-red-100 text-red-700 border-red-200',
};

// Nav items
export const NAV_ITEMS = [
  { label: 'Dashboard', href: '/', icon: 'LayoutDashboard' },
  { label: 'Opportunities', href: '/opportunities', icon: 'Lightbulb' },
  { label: 'Products', href: '/products', icon: 'Package' },
  { label: 'Experiments', href: '/experiments', icon: 'FlaskConical' },
  { label: 'Revenue', href: '/revenue', icon: 'DollarSign' },
  { label: 'AI Agents', href: '/agents', icon: 'Bot' },
  { label: 'Settings', href: '/settings', icon: 'Settings' },
] as const;
