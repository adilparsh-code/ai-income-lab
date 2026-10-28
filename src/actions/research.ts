'use server';

import { requireAdminAction } from '@/lib/agency/action-guard';
import {
  getResearchEngineStatus as load_getResearchEngineStatus,
} from '@/lib/loaders/research';
import type {
  ResearchEngineStatus,
} from '@/lib/loaders/research';

export type {
  ResearchEngineStatus,
};

export async function getResearchEngineStatus(): Promise<ResearchEngineStatus> {
  await requireAdminAction();
  return load_getResearchEngineStatus();
}
