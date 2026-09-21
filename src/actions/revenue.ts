'use server';

import { db } from '@/lib/db';
import { revalidatePath } from 'next/cache';

export interface CreateRevenueInput {
  date: string;
  revenueSource: string;
  grossRevenue: number;
  fees?: number;
  advertisingCost?: number;
  otherCosts?: number;
  currency?: string;
  referenceNote?: string;
  opportunityId?: string | null;
  productId?: string | null;
}

export interface UpdateRevenueInput extends Partial<CreateRevenueInput> {
  id: string;
}

/**
 * GET all revenue entries
 */
export async function getRevenues() {
  const revenues = await db.revenue.findMany({
    include: {
      opportunity: {
        select: {
          id: true,
          title: true,
        },
      },
      product: {
        select: {
          id: true,
          name: true,
        },
      },
    },
    orderBy: { date: 'desc' },
  });

  return revenues;
}

/**
 * GET revenue metrics summary
 */
export async function getRevenueSummary() {
  const revenues = await db.revenue.findMany();

  const totalGross = revenues.reduce((sum, r) => sum + r.grossRevenue, 0);
  const totalFees = revenues.reduce((sum, r) => sum + (r.fees || 0), 0);
  const totalAdCost = revenues.reduce((sum, r) => sum + (r.advertisingCost || 0), 0);
  const totalOtherCosts = revenues.reduce((sum, r) => sum + (r.otherCosts || 0), 0);
  const totalNet = revenues.reduce((sum, r) => sum + r.netRevenue, 0);

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const thisMonthNet = revenues
    .filter((r) => new Date(r.date) >= startOfMonth)
    .reduce((sum, r) => sum + r.netRevenue, 0);

  return {
    totalGross,
    totalFees,
    totalAdCost,
    totalOtherCosts,
    totalNet,
    thisMonthNet,
    entryCount: revenues.length,
  };
}

/**
 * Create a new revenue entry
 */
export async function createRevenue(input: CreateRevenueInput) {
  if (!input.revenueSource || input.revenueSource.trim().length === 0) {
    throw new Error('Revenue source is required');
  }
  if (input.grossRevenue === undefined || input.grossRevenue < 0) {
    throw new Error('Gross revenue must be a non-negative number');
  }

  const grossRevenue = input.grossRevenue;
  const fees = input.fees || 0;
  const advertisingCost = input.advertisingCost || 0;
  const otherCosts = input.otherCosts || 0;
  const netRevenue = grossRevenue - (fees + advertisingCost + otherCosts);

  const revenue = await db.revenue.create({
    data: {
      date: new Date(input.date),
      revenueSource: input.revenueSource.trim(),
      grossRevenue,
      fees,
      advertisingCost,
      otherCosts,
      netRevenue,
      currency: input.currency || 'USD',
      referenceNote: input.referenceNote?.trim() || '',
      opportunityId: input.opportunityId || null,
      productId: input.productId || null,
    },
  });

  revalidatePath('/revenue');
  revalidatePath('/');
  if (input.opportunityId) {
    revalidatePath(`/opportunities/${input.opportunityId}`);
  }

  return revenue;
}

/**
 * Update a revenue entry
 */
export async function updateRevenue(input: UpdateRevenueInput) {
  const { id, ...data } = input;

  const existing = await db.revenue.findUnique({ where: { id } });
  if (!existing) throw new Error('Revenue entry not found');

  const grossRevenue = data.grossRevenue !== undefined ? data.grossRevenue : existing.grossRevenue;
  const fees = data.fees !== undefined ? data.fees : existing.fees;
  const advertisingCost = data.advertisingCost !== undefined ? data.advertisingCost : existing.advertisingCost;
  const otherCosts = data.otherCosts !== undefined ? data.otherCosts : existing.otherCosts;
  const netRevenue = grossRevenue - (fees + advertisingCost + otherCosts);

  const revenue = await db.revenue.update({
    where: { id },
    data: {
      ...data,
      date: data.date ? new Date(data.date) : existing.date,
      grossRevenue,
      fees,
      advertisingCost,
      otherCosts,
      netRevenue,
      updatedAt: new Date(),
    },
  });

  revalidatePath('/revenue');
  revalidatePath('/');
  if (revenue.opportunityId) {
    revalidatePath(`/opportunities/${revenue.opportunityId}`);
  }

  return revenue;
}

/**
 * Delete a revenue entry
 */
export async function deleteRevenue(id: string) {
  const existing = await db.revenue.findUnique({ where: { id } });
  if (!existing) throw new Error('Revenue entry not found');

  await db.revenue.delete({ where: { id } });

  revalidatePath('/revenue');
  revalidatePath('/');
  if (existing.opportunityId) {
    revalidatePath(`/opportunities/${existing.opportunityId}`);
  }
}
