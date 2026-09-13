// Agent type definitions for AI Income Lab Phase 3.1

export type AgentType = 
  | 'research'
  | 'validation' 
  | 'product'
  | 'analytics'
  | 'business-manager';

export type AgentStatus = 'LIVE' | 'MOCKED' | 'PLANNED';

export type EvidenceType = 'AI_INFERENCE' | 'VERIFIED_DATA' | 'USER_ENTERED';

export type AgentExecutionStatus = 'idle' | 'running' | 'completed' | 'failed';

export interface Agent {
  id: string;
  type: AgentType;
  name: string;
  description: string;
  purpose: string;
  currentCapability: string;
  status: AgentStatus;
  evidencePolicy: string;
  safeExecutionState: boolean;
  icon: string;
}

export interface AgentRequest {
  agentType: AgentType;
  action: string;
  input: Record<string, unknown>;
  opportunityId?: string;
}

export interface AgentResult {
  success: boolean;
  output: Record<string, unknown>;
  reasoning: string;
  evidenceType: EvidenceType;
  error?: string;
  executionTime: number;
}

export interface AgentLogEntry {
  id: string;
  agentType: string;
  action: string;
  input: string;
  output: string;
  reasoning: string;
  evidenceType: string;
  createdAt: Date;
}