import { db } from '@/lib/db';
import { Agent, AgentRequest, AgentResult, EvidenceType, AgentType } from './types';
import { buildAgentLogData } from './agent-log-data';
export { buildAgentLogData } from './agent-log-data';
export type { AgentLogDataInput, AgentLogPersistedData } from './agent-log-data';

export abstract class BaseAgent implements Agent {
  id: string;
  type: AgentType;
  name: string;
  description: string;
  purpose: string;
  currentCapability: string;
  status: 'LIVE' | 'MOCKED' | 'PLANNED';
  evidencePolicy: string;
  safeExecutionState: boolean;
  icon: string;

  constructor(agent: Agent) {
    this.id = agent.id;
    this.type = agent.type;
    this.name = agent.name;
    this.description = agent.description;
    this.purpose = agent.purpose;
    this.currentCapability = agent.currentCapability;
    this.status = agent.status;
    this.evidencePolicy = agent.evidencePolicy;
    this.safeExecutionState = agent.safeExecutionState;
    this.icon = agent.icon;
  }

  abstract execute(request: AgentRequest): Promise<AgentResult>;

  protected async logExecution(
    action: string,
    input: Record<string, unknown>,
    result: AgentResult
  ): Promise<void> {
    try {
      const data = buildAgentLogData({ agentType: this.type, action, input, result });
      await db.agentLog.create({ data });
    } catch (error) {
      console.error(`Failed to log agent execution: ${error}`);
    }
  }

  protected validateHalalCompliance(halalStatus: string): boolean {
    if (halalStatus === 'NOT_ALLOWED') {
      return false;
    }
    if (halalStatus === 'REVIEW_REQUIRED') {
      // Requires human review before execution
      return false;
    }
    return true;
  }

  protected getMockResult(request: AgentRequest): AgentResult {
    return {
      success: true,
      output: {
        message: `[MOCKED] ${this.name} processed your request`,
        requestReceived: request,
        timestamp: new Date().toISOString(),
      },
      reasoning: `This is a mocked execution result. ${this.name} architecture is implemented but live capabilities are not yet active.`,
      evidenceType: 'AI_INFERENCE' as EvidenceType,
      executionTime: 0,
    };
  }
}