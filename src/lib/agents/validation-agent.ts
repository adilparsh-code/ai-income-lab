import { BaseAgent } from './base-agent';
import { AgentRequest, AgentResult, EvidenceType } from './types';

export class ValidationAgent extends BaseAgent {
  constructor() {
    super({
      id: 'validation-agent',
      type: 'validation',
      name: 'Validation Agent',
      description: 'Evaluates whether an idea deserves investment. Cross-references demand data, competition, and market fit.',
      purpose: 'Validate opportunity viability by analyzing market fit, competition, and potential return on investment.',
      currentCapability: 'Architecture implemented. Live validation capabilities coming in future phases. Currently returns mocked results only.',
      status: 'MOCKED',
      evidencePolicy: 'Validation scores are AI_INFERENCE until verified with real market data. Halal compliance status is always VERIFIED_DATA once human-reviewed.',
      safeExecutionState: true,
      icon: 'CheckCircle2',
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
          reasoning: 'Cannot validate this opportunity - it has failed halal compliance checks.',
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