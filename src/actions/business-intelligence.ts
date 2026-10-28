'use server';

import { requireAdminAction } from '@/lib/agency/action-guard';
import {
  getBusinessIntelligenceSummary as load_getBusinessIntelligenceSummary,
} from '@/lib/loaders/business-intelligence';
import type {
  BusinessIntelligenceSummary,
} from '@/lib/loaders/business-intelligence';

export type {
  BusinessIntelligenceSummary,
};

export async function getBusinessIntelligenceSummary(): Promise<BusinessIntelligenceSummary> {
  await requireAdminAction();
  return load_getBusinessIntelligenceSummary();
}
