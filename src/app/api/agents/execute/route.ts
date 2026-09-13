import { NextResponse } from 'next/server';
import { agentRegistry } from '@/lib/agents/agent-registry';
import { AgentRequest, AgentType } from '@/lib/agents/types';
import { logger } from '@/lib/server-log';

const VALID_AGENT_TYPES: AgentType[] = [
  'research', 'validation', 'product', 'analytics', 'business-manager',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function POST(request: Request) {
  // --- Parse/validate the request body safely ---
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    logger.warn('Agent execution rejected: malformed JSON body');
    return NextResponse.json(
      { success: false, error: 'Request body must be valid JSON' },
      { status: 400 }
    );
  }

  if (!isRecord(body)) {
    return NextResponse.json(
      { success: false, error: 'Request body must be a JSON object' },
      { status: 400 }
    );
  }

  const raw = body;
  const agentRequest: AgentRequest = {
    agentType: raw.agentType as AgentType,
    action: typeof raw.action === 'string' ? raw.action : '',
    input: isRecord(raw.input) ? raw.input : {},
    ...(typeof raw.opportunityId === 'string' && raw.opportunityId.length > 0
      ? { opportunityId: raw.opportunityId }
      : {}),
  };

  if (typeof agentRequest.agentType !== 'string' || !VALID_AGENT_TYPES.includes(agentRequest.agentType)) {
    logger.warn('Agent execution rejected: unknown agentType', { agentType: agentRequest.agentType });
    return NextResponse.json(
      { success: false, error: `Unknown agentType. Must be one of: ${VALID_AGENT_TYPES.join(', ')}` },
      { status: 400 }
    );
  }

  if (typeof agentRequest.action !== 'string' || agentRequest.action.trim().length === 0) {
    return NextResponse.json({ success: false, error: 'action is required and must be a non-empty string' }, { status: 400 });
  }

  logger.info('Agent execution started', {
    agentType: agentRequest.agentType,
    action: agentRequest.action,
  });

  try {
    const result = await agentRegistry.executeAgent(agentRequest);

    if (!result.success && result.error === 'Agent not found') {
      return NextResponse.json(result, { status: 404 });
    }

    return NextResponse.json(result);
  } catch (error) {
    // Never leak stack traces, secrets, or internal details to the client.
    logger.error('Agent execution failed unexpectedly', error, {
      agentType: agentRequest.agentType,
    });
    return NextResponse.json(
      { success: false, error: 'An unexpected error occurred while executing the agent' },
      { status: 500 }
    );
  }
}