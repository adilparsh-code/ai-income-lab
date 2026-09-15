// Phase 4.2.3: provider-agnostic prompts and schemas for Validation/Product AI.
// This module contains no provider-specific code. AI output remains AI_INFERENCE.
import type { AiJsonSchema } from './provider';

export const VALIDATION_AI_SCHEMA: AiJsonSchema = {
  required: ['assumptions', 'risks', 'tests', 'successCriteria', 'failureCriteria', 'recommendation', 'confidence'],
  properties: {
    assumptions: 'string[]',
    risks: 'object[]',
    tests: 'object[]',
    successCriteria: 'string[]',
    failureCriteria: 'string[]',
    evidenceRequirements: 'string[]',
    recommendation: 'string',
    confidence: 'number',
  },
};

export const PRODUCT_AI_SCHEMA: AiJsonSchema = {
  required: ['productConcept', 'mvpFeatures', 'buildPhases', 'monetizationModel', 'risks', 'assumptions', 'confidence'],
  properties: {
    productConcept: 'object',
    mvpFeatures: 'object[]',
    buildPhases: 'object[]',
    monetizationModel: 'string',
    monetizationRationale: 'string',
    pricingHypothesis: 'string',
    monetizationAssumptions: 'string[]',
    monetizationRisks: 'string[]',
    distributionChannels: 'string[]',
    risks: 'string[]',
    assumptions: 'string[]',
    confidence: 'number',
  },
};

function safeContext(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 6000) : '';
}

export function buildValidationPrompt(input: Record<string, unknown>): string {
  return [
    'You are the Validation Agent for AI Income Lab.',
    'Produce a structured validation plan for the supplied business opportunity.',
    'Treat all conclusions as hypotheses unless explicitly supplied as verified evidence.',
    'Do not invent market statistics, customers, competitors, prices, or external facts.',
    'Do not override halal safety rules. Do not recommend an impermissible activity.',
    'Return JSON only matching the requested schema.',
    '',
    `Objective: ${safeContext(input.validationObjective)}`,
    `Target audience: ${safeContext(input.targetAudience)}`,
    `Key assumptions: ${JSON.stringify(input.keyAssumptions ?? [])}`,
    `Constraints: ${JSON.stringify(input.validationConstraints ?? [])}`,
    `Preferred method: ${safeContext(input.preferredValidationMethod)}`,
  ].join('\n');
}

export function buildProductPrompt(input: Record<string, unknown>, validationContext?: unknown, researchContext?: unknown): string {
  return [
    'You are the Product Agent for AI Income Lab.',
    'Convert the supplied opportunity and available research/validation context into a practical MVP product specification.',
    'Treat AI-generated research and validation as hypotheses, not verified facts.',
    'Do not invent market statistics, customer counts, competitor facts, revenue claims, or prices.',
    'Do not override halal safety rules. Do not recommend an impermissible activity.',
    'Return JSON only matching the requested schema.',
    '',
    `Objective: ${safeContext(input.productObjective)}`,
    `Product type: ${safeContext(input.productType)}`,
    `Target audience: ${safeContext(input.targetAudience)}`,
    `Customer problem: ${safeContext(input.customerProblem)}`,
    `Platform: ${safeContext(input.preferredPlatform)}`,
    `Constraints: ${JSON.stringify(input.constraints ?? [])}`,
    `Monetization preference: ${safeContext(input.monetizationPreference)}`,
    `Research context: ${safeContext(researchContext)}`,
    `Validation context: ${safeContext(validationContext)}`,
  ].join('\n');
}
