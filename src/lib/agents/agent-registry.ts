import { BaseAgent } from './base-agent';
import { AgentType, AgentRequest, AgentResult } from './types';
import { ResearchAgent } from './research-agent';
import { ValidationAgent } from './validation-agent';
import { ProductAgent } from './product-agent';
import { AnalyticsAgent } from './analytics-agent';
import { BusinessManagerAgent } from './business-manager-agent';

class AgentRegistry {
  private agents: Map<AgentType, BaseAgent> = new Map();

  constructor() {
    this.initializeAgents();
  }

  private initializeAgents(): void {
    // Register all available agents
    this.agents.set('research', new ResearchAgent());
    this.agents.set('validation', new ValidationAgent());
    this.agents.set('product', new ProductAgent());
    this.agents.set('analytics', new AnalyticsAgent());
    this.agents.set('business-manager', new BusinessManagerAgent());
  }

  getAgent(type: AgentType): BaseAgent | undefined {
    return this.agents.get(type);
  }

  getAllAgents(): BaseAgent[] {
    return Array.from(this.agents.values());
  }

  async executeAgent(request: AgentRequest): Promise<AgentResult> {
    const agent = this.getAgent(request.agentType);
    
    if (!agent) {
      return {
        success: false,
        output: {},
        reasoning: `Agent type "${request.agentType}" not found in registry`,
        evidenceType: 'AI_INFERENCE',
        error: 'Agent not found',
        executionTime: 0,
      };
    }

    if (!agent.safeExecutionState) {
      return {
        success: false,
        output: {},
        reasoning: `${agent.name} is not in a safe execution state`,
        evidenceType: 'AI_INFERENCE',
        error: 'Agent not safe for execution',
        executionTime: 0,
      };
    }

    if (agent.status === 'PLANNED') {
      return {
        success: false,
        output: {},
        reasoning: `${agent.name} is still in planning phase and not available for execution`,
        evidenceType: 'AI_INFERENCE',
        error: 'Agent not yet available',
        executionTime: 0,
      };
    }

    const startTime = Date.now();
    try {
      const result = await agent.execute(request);
      const executionTime = Date.now() - startTime;
      return { ...result, executionTime };
    } catch (error) {
      const executionTime = Date.now() - startTime;
      return {
        success: false,
        output: {},
        reasoning: `Execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        evidenceType: 'AI_INFERENCE',
        error: error instanceof Error ? error.message : 'Unknown error',
        executionTime,
      };
    }
  }
}

export const agentRegistry = new AgentRegistry();