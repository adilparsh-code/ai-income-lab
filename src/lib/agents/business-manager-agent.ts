import { BaseAgent } from './base-agent';
import { AgentRequest, AgentResult, EvidenceType } from './types';

export class BusinessManagerAgent extends BaseAgent {
  constructor() {
    super({
      id: 'business-manager-agent',
      type: 'business-manager',
      name: 'Business Manager',
      description: 'Orchestrates other agents to execute complete business workflows. Coordinates research, validation, and execution.',
      purpose: 'Coordinate other AI agents to execute end-to-end business workflows, ensuring proper sequence and compliance.',
      currentCapability: 'Architecture implemented. Live orchestration capabilities coming in future phases. Currently returns mocked results only.',
      status: 'PLANNED',
      evidencePolicy: 'Business decisions are based on aggregated data from other agents. Final recommendations require human approval before implementation.',
      safeExecutionState: true,
      icon: 'Crown',
    });
  }

  async execute(request: AgentRequest): Promise<AgentResult> {
    // If opportunityId is provided, check halal compliance first
    if (request.input.opportunityHalalStatus) {
      const isSafe = this.validateHalalCompliance(request.input.opportunityHalalStatus as string);
      if (!isSafe) {
        return {
          success: false,
          output: {},
          reasoning: 'Cannot create business workflow for this opportunity - it has failed halal compliance checks.',
          evidenceType: 'AI_INFERENCE' as EvidenceType,
          error: 'Halal compliance check failed',
          executionTime: 0,
        };
      }
    }

    // Return mocked result as live capabilities are not yet implemented
    const result = this.getMockResult(request);
    await this.logExecution(request.action, request.input, result);
    return result;
  }
}