// Shared agent execution helpers (Phase 4.2.3).
// Small utilities used by multiple agents so the AI generation layer is used
// consistently and AgentLog entries are never duplicated or silently lost.

import { db } from '@/lib/db';
import { buildAgentLogData } from './agent-log-data';
import type { AgentRequest, AgentResult, AgentStatus } from './types';
import { identifyExecutionMode } from '@/lib/ai/generate';

/** Live/mock execution mode for the configured provider. */
export function getExecutionMode(): { provider: string; isLive: boolean; isMocked: boolean; capabilityStatus: AgentStatus } {
  const mode = identifyExecutionMode();
  return {
    provider: mode.provider,
    isLive: mode.isLive,
    isMocked: mode.isMocked,
    capabilityStatus: mode.isLive ? 'LIVE' : 'MOCKED',
  };
}

export interface PersistAgentLogInput {
  agentType: string;
  action: string;
  request: AgentRequest;
  result: AgentResult;
}

/**
 * Persist exactly one AgentLog entry for an execution. Returns the log id, or
 * undefined when persistence failed (the failure is logged, never thrown, so
 * a logging outage cannot break or duplicate agent executions).
 */
export async function persistAgentLog(input: PersistAgentLogInput): Promise<string | undefined> {
  try {
    const entry = await db.agentLog.create({
      data: buildAgentLogData({
        agentType: input.agentType,
        action: input.action,
        input: input.request.input,
        result: input.result,
      }),
    });
    return entry.id;
  } catch (error) {
    console.error(`Failed to persist ${input.agentType} AgentLog: ${error}`);
    return undefined;
  }
}
