// Phase 5.6 — explicit Ruflo runtime registration.
//
// This module is server-only by convention: it reads runtime credentials from
// environment variables and performs a real health check before registering
// the runtime handle. No automatic import-time connection is performed.

import {
  registerRufloOrchestrator,
  type RufloOrchestratorHandle,
} from './connector';
import { getConfiguredRufloMcpClient, type RufloMcpClient } from './runtime-client';

export interface RufloRuntimeConnection {
  connected: true;
  runtimeId: string;
  client: RufloMcpClient;
}

export interface RufloRuntimeConnectionFailure {
  connected: false;
  reason: string;
}

export async function connectConfiguredRufloRuntime(): Promise<
  RufloRuntimeConnection | RufloRuntimeConnectionFailure
> {
  const client = getConfiguredRufloMcpClient();

  if (!client) {
    return {
      connected: false,
      reason: 'RUFLO_MCP_URL is not configured; Ruflo remains disconnected.',
    };
  }

  try {
    const health = await client.health();

    if (!health.healthy) {
      return {
        connected: false,
        reason: `Ruflo health check failed (HTTP ${health.status}); runtime was not registered.`,
      };
    }

    const runtimeId = `ruflo-http-${new URL(process.env.RUFLO_MCP_URL!).host}`;
    const handle: RufloOrchestratorHandle = { id: runtimeId };
    const registration = registerRufloOrchestrator(handle);

    if (!registration.ok) {
      return {
        connected: false,
        reason: registration.error || 'Ruflo runtime registration failed.',
      };
    }

    return { connected: true, runtimeId, client };
  } catch (error) {
    return {
      connected: false,
      reason: error instanceof Error
        ? `Ruflo health check failed: ${error.message}`
        : 'Ruflo health check failed.',
    };
  }
}
