'use server';

import { db } from '@/lib/db';
import { revalidatePath } from 'next/cache';
import { requireAdminAction } from '@/lib/agency/action-guard';
import { currentScope } from '@/lib/tenancy/action-scope';
import {
  assertOpportunityInScope,
  experimentWhere,
} from '@/lib/tenancy/relation-scope';

export interface CreateExperimentInput {
  hypothesis: string;
  target?: string;
  budget?: number;
  startDate?: string | null;
  endDate?: string | null;
  expectedResult?: string;
  opportunityId?: string | null;
}

export interface UpdateExperimentInput {
  id: string;
  hypothesis?: string;
  target?: string;
  budget?: number;
  startDate?: string | null;
  endDate?: string | null;
  expectedResult?: string;
  actualResult?: string;
  visitors?: number;
  leads?: number;
  clicks?: number;
  sales?: number;
  revenue?: number;
  profit?: number;
  conversionRate?: number;
  decision?: 'SCALE' | 'ITERATE' | 'PAUSE' | 'KILL' | null;
  opportunityId?: string | null;
}

/**
 * GET all experiments
 */
export async function getExperiments() {
  await requireAdminAction();
  const scope = await currentScope('tenant:read', 'action:getExperiments');
  const experiments = await db.experiment.findMany({
    where: experimentWhere(scope),
    include: {
      opportunity: {
        select: {
          id: true,
          title: true,
          halalStatus: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return experiments;
}

/**
 * GET single experiment by ID
 */
export async function getExperiment(id: string) {
  await requireAdminAction();
  const scope = await currentScope('tenant:read', 'action:getExperiment');
  const experiment = await db.experiment.findFirst({
    where: { id, ...experimentWhere(scope) },
    include: {
      opportunity: true,
    },
  });

  return experiment;
}

/**
 * Create a new experiment linked to an opportunity
 */
export async function createExperiment(input: CreateExperimentInput) {
  await requireAdminAction();
  const scope = await currentScope('tenant:write', 'action:createExperiment');
  if (!input.hypothesis || input.hypothesis.trim().length === 0) {
    throw new Error('Hypothesis is required');
  }

  if (input.opportunityId) await assertOpportunityInScope(scope, input.opportunityId);

  const experiment = await db.experiment.create({
    data: {
      hypothesis: input.hypothesis.trim(),
      target: input.target?.trim() || '',
      budget: input.budget || 0,
      startDate: input.startDate ? new Date(input.startDate) : null,
      endDate: input.endDate ? new Date(input.endDate) : null,
      expectedResult: input.expectedResult?.trim() || '',
      opportunityId: input.opportunityId || null,
    },
  });

  revalidatePath('/experiments');
  if (input.opportunityId) {
    revalidatePath(`/opportunities/${input.opportunityId}`);
  }
  revalidatePath('/');

  return experiment;
}

/**
 * Update an experiment
 */
export async function updateExperiment(input: UpdateExperimentInput) {
  await requireAdminAction();
  const scope = await currentScope('tenant:write', 'action:updateExperiment');
  const { id, ...data } = input;

  const existing = await db.experiment.findFirst({ where: { id, ...experimentWhere(scope) } });
  if (!existing) throw new Error('Experiment not found');

  // Auto-calculate conversion rate if visitors and sales provided
  const visitors = data.visitors !== undefined ? data.visitors : existing.visitors;
  const sales = data.sales !== undefined ? data.sales : existing.sales;
  const conversionRate = visitors > 0 ? (sales / visitors) * 100 : 0;

  if (data.opportunityId) await assertOpportunityInScope(scope, data.opportunityId);

  const updated = await db.experiment.updateMany({
    where: { id, ...experimentWhere(scope) },
    data: {
      ...data,
      startDate: data.startDate !== undefined ? (data.startDate ? new Date(data.startDate) : null) : existing.startDate,
      endDate: data.endDate !== undefined ? (data.endDate ? new Date(data.endDate) : null) : existing.endDate,
      conversionRate,
      updatedAt: new Date(),
    },
  });
  if (updated.count === 0) throw new Error('Experiment not found');
  const experiment = await db.experiment.findFirst({ where: { id, ...experimentWhere(scope) } });
  if (!experiment) throw new Error('Experiment not found');

  revalidatePath('/experiments');
  revalidatePath(`/experiments/${id}`);
  if (experiment.opportunityId) {
    revalidatePath(`/opportunities/${experiment.opportunityId}`);
  }
  revalidatePath('/');

  return experiment;
}

/**
 * Delete an experiment
 */
export async function deleteExperiment(id: string) {
  await requireAdminAction();
  const scope = await currentScope('tenant:write', 'action:deleteExperiment');
  const existing = await db.experiment.findFirst({ where: { id, ...experimentWhere(scope) } });
  if (!existing) throw new Error('Experiment not found');

  const removed = await db.experiment.deleteMany({ where: { id, ...experimentWhere(scope) } });
  if (removed.count === 0) throw new Error('Experiment not found');

  revalidatePath('/experiments');
  if (existing.opportunityId) {
    revalidatePath(`/opportunities/${existing.opportunityId}`);
  }
  revalidatePath('/');
}
