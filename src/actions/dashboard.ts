'use server';

import { requireAdminAction } from '@/lib/agency/action-guard';
import {
  getDashboardStats as load_getDashboardStats,
  getNextBestAction as load_getNextBestAction,
  getRevenueChartData as load_getRevenueChartData,
} from '@/lib/loaders/dashboard';
import type {
  DashboardStats,
  NextBestAction,
  RevenueChartData,
} from '@/lib/loaders/dashboard';

export type {
  DashboardStats,
  NextBestAction,
  RevenueChartData,
};

export async function getDashboardStats(): Promise<DashboardStats> {
  await requireAdminAction();
  return load_getDashboardStats();
}

export async function getNextBestAction(): Promise<NextBestAction | null> {
  await requireAdminAction();
  return load_getNextBestAction();
}

export async function getRevenueChartData(): Promise<RevenueChartData[]> {
  await requireAdminAction();
  return load_getRevenueChartData();
}
