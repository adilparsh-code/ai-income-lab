'use server';

import type { PortfolioLifecycleSummary } from '@/lib/ruflo/lifecycle';
import { requireAdminAction } from '@/lib/agency/action-guard';
import {
  getLifecycleOverview as load_getLifecycleOverview,
} from '@/lib/loaders/lifecycle';

export async function getLifecycleOverview(): Promise<PortfolioLifecycleSummary> {
  await requireAdminAction();
  return load_getLifecycleOverview();
}
