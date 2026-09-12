'use server';

import { db } from '@/lib/db';
import { calculateOpportunityScore } from '@/lib/scoring';
import { screenForHalalCompliance } from '@/lib/halal-filter';
import { revalidatePath } from 'next/cache';

// Types for filters
export interface OpportunityFilters {
  search?: string;
  status?: string[];
  category?: string[];
  halalStatus?: string[];
  sortBy?: 'overallScore' | 'createdAt' | 'title' | 'demandScore' | 'commercialIntentScore';
  sortOrder?: 'asc' | 'desc';
}

/**
 * GET all opportunities with filters
 */
export async function getOpportunities(filters: OpportunityFilters = {}) {
  const { search, status, category, halalStatus, sortBy = 'overallScore', sortOrder = 'desc' } = filters;
  
  const where: any = {};
  
  if (search) {
    where.OR = [
      { title: { contains: search } },
      { category: { contains: search } },
      { targetAudience: { contains: search } },
      { problemSolved: { contains: search } },
    ];
  }
  
  if (status && status.length > 0) {
    where.status = { in: status };
  }
  
  if (category && category.length > 0) {
    where.category = { in: category };
  }
  
  if (halalStatus && halalStatus.length > 0) {
    where.halalStatus = { in: halalStatus };
  }
  
  const opportunities = await db.opportunity.findMany({
    where,
    orderBy: { [sortBy]: sortOrder },
  });
  
  return opportunities;
}

/**
 * GET single opportunity by ID
 */
export async function getOpportunity(id: string) {
  const opportunity = await db.opportunity.findUnique({
    where: { id },
    include: {
      products: true,
      experiments: true,
      revenues: true,
    },
  });
  
  if (!opportunity) return null;
  
  // Calculate score breakdown
  const scoreResult = calculateOpportunityScore({
    demandScore: opportunity.demandScore,
    commercialIntentScore: opportunity.commercialIntentScore,
    competitionScore: opportunity.competitionScore,
    startupCostScore: costToScore(opportunity.estimatedStartupCost),
    automationScore: opportunity.automationScore,
    differentiationScore: opportunity.differentiationScore,
    monetizationScore: opportunity.monetizationScore,
    halalConfidenceScore: opportunity.halalConfidenceScore,
    halalStatus: opportunity.halalStatus as 'HALAL' | 'REVIEW_REQUIRED' | 'NOT_ALLOWED',
  });
  
  return { ...opportunity, scoreResult };
}

/**
 * Create a new opportunity
 */
export async function createOpportunity(data: {
  title: string;
  category: string;
  businessModel: string;
  targetAudience: string;
  problemSolved: string;
  monetizationMethod: string;
  estimatedStartupCost: number;
  demandScore: number;
  competitionScore: number;
  commercialIntentScore: number;
  automationScore: number;
  differentiationScore: number;
  monetizationScore: number;
  halalConfidenceScore: number;
  halalStatus: string;
  confidenceLevel: string;
  status: string;
  evidenceNotes: string;
  risks: string;
  nextAction: string;
}) {
  // Run halal screening
  const halalResult = screenForHalalCompliance(
    data.title,
    data.problemSolved,
    data.category,
    data.businessModel,
    data.monetizationMethod
  );
  
  // Use the more restrictive halal status
  const effectiveHalalStatus = getStricterHalalStatus(data.halalStatus, halalResult.status);
  
  // Calculate overall score
  const scoreResult = calculateOpportunityScore({
    demandScore: data.demandScore,
    commercialIntentScore: data.commercialIntentScore,
    competitionScore: data.competitionScore,
    startupCostScore: costToScore(data.estimatedStartupCost),
    automationScore: data.automationScore,
    differentiationScore: data.differentiationScore,
    monetizationScore: data.monetizationScore,
    halalConfidenceScore: data.halalConfidenceScore,
    halalStatus: effectiveHalalStatus as 'HALAL' | 'REVIEW_REQUIRED' | 'NOT_ALLOWED',
  });
  
  const opportunity = await db.opportunity.create({
    data: {
      ...data,
      halalStatus: effectiveHalalStatus,
      overallScore: scoreResult.overallScore,
    },
  });
  
  revalidatePath('/opportunities');
  revalidatePath('/');
  
  return opportunity;
}

/**
 * Update an existing opportunity
 */
export async function updateOpportunity(
  id: string,
  data: Partial<Parameters<typeof createOpportunity>[0]>
) {
  // Get existing opportunity
  const existing = await db.opportunity.findUnique({ where: { id } });
  if (!existing) throw new Error('Opportunity not found');
  
  const merged = { ...existing, ...data };
  
  // Re-run halal screening if relevant fields changed
  if (data.title || data.category || data.businessModel || data.monetizationMethod || data.problemSolved) {
    const halalResult = screenForHalalCompliance(
      merged.title,
      merged.problemSolved,
      merged.category,
      merged.businessModel,
      merged.monetizationMethod
    );
    merged.halalStatus = getStricterHalalStatus(merged.halalStatus, halalResult.status);
  }
  
  // Recalculate score
  const scoreResult = calculateOpportunityScore({
    demandScore: merged.demandScore,
    commercialIntentScore: merged.commercialIntentScore,
    competitionScore: merged.competitionScore,
    startupCostScore: costToScore(merged.estimatedStartupCost),
    automationScore: merged.automationScore,
    differentiationScore: merged.differentiationScore,
    monetizationScore: merged.monetizationScore,
    halalConfidenceScore: merged.halalConfidenceScore,
    halalStatus: merged.halalStatus as 'HALAL' | 'REVIEW_REQUIRED' | 'NOT_ALLOWED',
  });
  
  const opportunity = await db.opportunity.update({
    where: { id },
    data: {
      ...data,
      halalStatus: merged.halalStatus,
      overallScore: scoreResult.overallScore,
      updatedAt: new Date(),
    },
  });
  
  revalidatePath('/opportunities');
  revalidatePath(`/opportunities/${id}`);
  revalidatePath('/');
  
  return opportunity;
}

/**
 * Delete an opportunity
 */
export async function deleteOpportunity(id: string) {
  await db.opportunity.delete({ where: { id } });
  revalidatePath('/opportunities');
  revalidatePath('/');
}

/**
 * Helper: convert dollar cost to 0-100 score (higher = lower cost = better)
 */
function costToScore(cost: number): number {
  if (cost <= 0) return 95;
  if (cost <= 50) return 90;
  if (cost <= 100) return 85;
  if (cost <= 250) return 75;
  if (cost <= 500) return 65;
  if (cost <= 1000) return 55;
  if (cost <= 2500) return 40;
  if (cost <= 5000) return 25;
  return 10;
}

/**
 * Helper: get the stricter of two halal statuses
 */
function getStricterHalalStatus(a: string, b: string): string {
  const order = ['HALAL', 'REVIEW_REQUIRED', 'NOT_ALLOWED'];
  const aIndex = order.indexOf(a);
  const bIndex = order.indexOf(b);
  return order[Math.max(aIndex, bIndex)] || a;
}
