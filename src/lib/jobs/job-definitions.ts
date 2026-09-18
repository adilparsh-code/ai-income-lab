// Phase 4.5.2 — Job definitions: per-type payload validation.
//
// Pure module. The runner validates a job's payload here BEFORE creating a
// row or touching an agent: malformed user input is rejected up front and is
// never retried (see job-runner retry policy).

import type { JobPayload, JobType } from './types';

export interface JobValidationResult {
  valid: boolean;
  errors: string[];
}

function requireString(value: unknown, field: string, errors: string[], maxLength = 4000): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${field} is required and must be a non-empty string`);
  } else if (value.length > maxLength) {
    errors.push(`${field} must be at most ${maxLength} characters`);
  }
}

function optionalString(value: unknown, field: string, errors: string[], maxLength = 4000): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') errors.push(`${field} must be a string if provided`);
  else if (value.length > maxLength) errors.push(`${field} must be at most ${maxLength} characters`);
}

function optionalStringArray(value: unknown, field: string, errors: string[]): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    errors.push(`${field} must be an array of strings if provided`);
  }
}

const VALIDATION_METHODS = [
  'LANDING_PAGE', 'SURVEY', 'INTERVIEW', 'PREORDER',
  'CONTENT_TEST', 'PRICE_TEST', 'EXPERIMENT', 'MANUAL_RESEARCH',
] as const;

const PRODUCT_TYPES = [
  'DIGITAL_PRODUCT', 'SAAS', 'WEB_APP', 'MOBILE_APP',
  'TEMPLATE', 'PRINTABLE', 'COURSE', 'TOOL', 'SERVICE_PRODUCT',
] as const;

const MONETIZATION_MODELS = [
  'ONE_TIME_PURCHASE', 'SUBSCRIPTION', 'FREEMIUM',
  'SERVICE', 'LICENSE', 'AFFILIATE', 'AD_SUPPORTED',
] as const;

const BM_SCOPES = [
  'OPPORTUNITY_SELECTION', 'VALIDATION_REVIEW', 'PRODUCT_DECISION',
  'SCALE_DECISION', 'FULL_BUSINESS_REVIEW',
] as const;

const STAGES = ['RESEARCH', 'VALIDATION', 'PRODUCT', 'EXPERIMENT', 'TRACKING'] as const;

/**
 * Validate a payload against its job type. Deliberately shallow-but-strict:
 * types and lengths are checked; semantic interpretation is left to the
 * existing agents (no duplicated business logic).
 */
export function validateJobPayload(jobType: JobType, payload: JobPayload): JobValidationResult {
  const errors: string[] = [];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { valid: false, errors: ['Job payload must be a JSON object'] };
  }

  // Optional opportunity scope, shared by all job types.
  optionalString(payload.opportunityId, 'opportunityId', errors, 128);

  switch (jobType) {
    case 'RESEARCH':
      requireString(payload.researchObjective, 'researchObjective', errors);
      optionalString(payload.targetAudience, 'targetAudience', errors);
      optionalString(payload.marketCategory, 'marketCategory', errors);
      optionalString(payload.geography, 'geography', errors);
      optionalStringArray(payload.constraints, 'constraints', errors);
      optionalStringArray(payload.halalRequirements, 'halalRequirements', errors);
      break;

    case 'VALIDATION':
      requireString(payload.validationObjective, 'validationObjective', errors);
      optionalString(payload.targetAudience, 'targetAudience', errors);
      optionalStringArray(payload.keyAssumptions, 'keyAssumptions', errors);
      optionalStringArray(payload.validationConstraints, 'validationConstraints', errors);
      if (
        payload.preferredValidationMethod !== undefined &&
        payload.preferredValidationMethod !== null &&
        !(VALIDATION_METHODS as readonly string[]).includes(String(payload.preferredValidationMethod))
      ) {
        errors.push(`preferredValidationMethod must be one of: ${VALIDATION_METHODS.join(', ')}`);
      }
      optionalStringArray(payload.halalRequirements, 'halalRequirements', errors);
      break;

    case 'PRODUCT':
      requireString(payload.productObjective, 'productObjective', errors);
      if (
        payload.productType !== undefined &&
        payload.productType !== null &&
        !(PRODUCT_TYPES as readonly string[]).includes(String(payload.productType))
      ) {
        errors.push(`productType must be one of: ${PRODUCT_TYPES.join(', ')}`);
      } else if (payload.productType === undefined || payload.productType === null) {
        errors.push('productType is required (one of: ' + PRODUCT_TYPES.join(', ') + ')');
      }
      optionalString(payload.targetAudience, 'targetAudience', errors);
      optionalString(payload.customerProblem, 'customerProblem', errors);
      optionalString(payload.preferredPlatform, 'preferredPlatform', errors);
      optionalStringArray(payload.constraints, 'constraints', errors);
      optionalString(payload.budgetConstraints, 'budgetConstraints', errors);
      if (
        payload.monetizationPreference !== undefined &&
        payload.monetizationPreference !== null &&
        !(MONETIZATION_MODELS as readonly string[]).includes(String(payload.monetizationPreference))
      ) {
        errors.push(`monetizationPreference must be one of: ${MONETIZATION_MODELS.join(', ')}`);
      }
      optionalStringArray(payload.halalRequirements, 'halalRequirements', errors);
      break;

    case 'ANALYTICS':
      // Analytics reads recorded data; opportunityId or analyticsObjective scopes it.
      if (!payload.opportunityId) {
        requireString(payload.analyticsObjective, 'analyticsObjective', errors);
      }
      optionalString(payload.analyticsObjective, 'analyticsObjective', errors);
      break;

    case 'BUSINESS_MANAGER':
      if (
        payload.decisionScope !== undefined &&
        payload.decisionScope !== null &&
        !(BM_SCOPES as readonly string[]).includes(String(payload.decisionScope))
      ) {
        errors.push(`decisionScope must be one of: ${BM_SCOPES.join(', ')}`);
      } else if (payload.decisionScope === undefined || payload.decisionScope === null) {
        errors.push('decisionScope is required (one of: ' + BM_SCOPES.join(', ') + ')');
      }
      optionalString(payload.notes, 'notes', errors);
      break;

    case 'OPPORTUNITY_PIPELINE':
      requireString(payload.objective, 'objective', errors);
      if (
        payload.stages !== undefined &&
        payload.stages !== null
      ) {
        if (!Array.isArray(payload.stages) || payload.stages.some((s) => !(STAGES as readonly string[]).includes(String(s)))) {
          errors.push(`stages must be a subset of: ${STAGES.join(', ')}`);
        }
      }
      break;
  }

  return { valid: errors.length === 0, errors };
}
