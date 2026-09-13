import { NextResponse } from 'next/server';
import { agentRegistry } from '@/lib/agents/agent-registry';
import { AgentRequest } from '@/lib/agents/types';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const agentRequest: AgentRequest = body;

    if (!agentRequest.agentType) {
      return NextResponse.json(
        { success: false, error: 'agentType is required' },
        { status: 400 }
      );
    }

    const result = await agentRegistry.executeAgent(agentRequest);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Agent execution API error:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error occurred' 
      },
      { status: 500 }
    );
  }
}