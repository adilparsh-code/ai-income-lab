// Pure AgentLog data mapper (Phase 4.2.2).
// Side-effect free so it can be unit-tested offline (no DB). Maps an execution
// result — including optional AI usage metadata (provider/model/tokens/cost,
// fallback) — into the Prisma AgentLog shape. Re-exported from BaseAgent.

import type { AgentResult, EvidenceType } from './types';

export interface AgentLogDataInput {
  agentType: string;
  action: string;
  input: Record<string, unknown>;
  result: AgentResult;
}

export interface AgentLogPersistedData {
  agentType: string;
  action: string;
  input: string;
  output: string;
  reasoning: string;
  evidenceType: EvidenceType | string;
  aiProvider: string | null;
  aiModel: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  fallbackUsed: boolean;
}

export function buildAgentLogData(input: AgentLogDataInput): AgentLogPersistedData {
  return {
    agentType: input.agentType,
    action: input.action,
    input: JSON.stringify(input.input),
    output: JSON.stringify(input.result.output),
    reasoning: input.result.reasoning,
    evidenceType: input.result.evidenceType,
    aiProvider: input.result.aiUsage?.provider ?? null,
    aiModel: input.result.aiUsage?.model ?? null,
    inputTokens: input.result.aiUsage?.inputTokens ?? null,
    outputTokens: input.result.aiUsage?.outputTokens ?? null,
    estimatedCostUsd: input.result.aiUsage?.estimatedCostUsd ?? null,
    fallbackUsed: input.result.fallbackUsed ?? false,
  };
}