import { db } from '@/lib/db';
import { Agent, AgentRequest, AgentResult, EvidenceType, AgentType } from './types';

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
      await db.agentLog.create({
        data: {
          agentType: this.type,
          action: action,
          input: JSON.stringify(input),
          output: JSON.stringify(result.output),
          reasoning: result.reasoning,
          evidenceType: result.evidenceType,
          // Phase 4.2.1: optional AI attribution. Nulls when deterministic/mock.
          aiProvider: result.aiUsage?.provider ?? null,
          aiModel: result.aiUsage?.model ?? null,
          inputTokens: result.aiUsage?.inputTokens ?? null,
          outputTokens: result.aiUsage?.outputTokens ?? null,
          estimatedCostUsd: result.aiUsage?.estimatedCostUsd ?? null,
          fallbackUsed: result.fallbackUsed ?? false,
        },
      });
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