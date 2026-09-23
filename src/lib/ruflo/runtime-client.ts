// Phase 5.6 — Ruflo HTTP/MCP runtime client.
//
// Connects AI Income Lab to a real Ruflo V3 MCP server over HTTP.
// The client is deliberately narrow:
// - server-side only; no browser exposure
// - health + initialize + tools/call only
// - tool names are allowlisted
// - workflow execution remains inside AI Income Lab's existing runner
// - no credentials are accepted in task payloads
//
// Ruflo V3 documents the HTTP transport at /health and /rpc. The runtime is
// optional: if RUFLO_MCP_URL is absent, the application remains disconnected.

import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_DESCRIPTION_LENGTH = 2_000;

export const RUFLO_ALLOWED_TOOLS = [
  'system/health',
  'system/info',
  'swarm/init',
  'swarm/status',
  'agent/list',
  'tasks/create',
  'tasks/list',
  'tasks/status',
  'tasks/results',
] as const;

export type RufloAllowedTool = (typeof RUFLO_ALLOWED_TOOLS)[number];

export interface RufloRuntimeConfig {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
}

export interface RufloHealth {
  healthy: boolean;
  status: number;
  body: unknown;
}

export interface RufloTaskRequest {
  type: 'research' | 'validation' | 'product' | 'analysis' | 'review' | 'test';
  description: string;
  priority?: number;
  dependencies?: string[];
  assignToAgentType?: string;
  timeout?: number;
  metadata: {
    correlationId: string;
    idempotencyKey: string;
    workflowId?: string;
  };
}

export interface RufloMcpClient {
  health(): Promise<RufloHealth>;
  callTool<T = unknown>(tool: RufloAllowedTool, args?: Record<string, unknown>): Promise<T>;
  createTask(request: RufloTaskRequest): Promise<TypedTaskResult>;
}

export interface TypedTaskResult {
  taskId: string;
  status: string;
  createdAt: string;
  queuePosition?: number;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Ruflo runtime URL must use HTTP or HTTPS.');
  }
  return url.toString().replace(/\/$/, '');
}

function timeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(Math.min(Math.max(timeoutMs, 1_000), MAX_TIMEOUT_MS));
}

function authHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function requestJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    ...init,
    signal: timeoutSignal(timeoutMs),
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
    cache: 'no-store',
  });

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 4_000);
    }
  }

  return { status: response.status, body };
}

export function createRufloMcpClient(config: RufloRuntimeConfig): RufloMcpClient {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const timeoutMs = Math.min(Math.max(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS);

  async function health(): Promise<RufloHealth> {
    const result = await requestJson(
      `${baseUrl}/health`,
      { headers: authHeaders(config.token) },
      timeoutMs,
    );
    const body = result.body as { healthy?: unknown } | null;
    return {
      healthy: result.status >= 200 && result.status < 300 && body?.healthy !== false,
      status: result.status,
      body: result.body,
    };
  }

  async function callTool<T = unknown>(
    tool: RufloAllowedTool,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    const id = randomUUID();

    const initialize = await requestJson(
      `${baseUrl}/rpc`,
      {
        method: 'POST',
        headers: authHeaders(config.token),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `${id}:init`,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'ai-income-lab', version: '5.6' },
          },
        }),
      },
      timeoutMs,
    );

    if (initialize.status < 200 || initialize.status >= 300 || (initialize.body as { error?: unknown })?.error) {
      throw new Error(`Ruflo initialize failed (HTTP ${initialize.status}).`);
    }

    const result = await requestJson(
      `${baseUrl}/rpc`,
      {
        method: 'POST',
        headers: authHeaders(config.token),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name: tool, arguments: args },
        }),
      },
      timeoutMs,
    );

    if (result.status < 200 || result.status >= 300) {
      throw new Error(`Ruflo tool call failed (HTTP ${result.status}).`);
    }

    const envelope = result.body as { result?: T; error?: { message?: string } } | null;
    if (envelope?.error) {
      throw new Error(envelope.error.message || 'Ruflo tool call failed.');
    }

    return envelope?.result as T;
  }

  async function createTask(request: RufloTaskRequest): Promise<TypedTaskResult> {
    const description = request.description.trim().slice(0, MAX_DESCRIPTION_LENGTH);
    if (!description) throw new Error('Ruflo task description is required.');

    const priority = Math.min(Math.max(request.priority ?? 5, 1), 10);
    const timeout = request.timeout
      ? Math.min(Math.max(request.timeout, 1_000), MAX_TIMEOUT_MS)
      : undefined;

    return callTool<TypedTaskResult>('tasks/create', {
      type: request.type,
      description,
      priority,
      ...(request.dependencies?.length ? { dependencies: request.dependencies.slice(0, 20) } : {}),
      ...(request.assignToAgentType ? { assignToAgentType: request.assignToAgentType.slice(0, 100) } : {}),
      ...(timeout ? { timeout } : {}),
      metadata: {
        correlationId: request.metadata.correlationId,
        idempotencyKey: request.metadata.idempotencyKey,
        ...(request.metadata.workflowId ? { workflowId: request.metadata.workflowId } : {}),
        source: 'ai-income-lab',
      },
    });
  }

  return { health, callTool, createTask };
}

/**
 * Server-side runtime configuration. Returns null when the operator has not
 * configured Ruflo; this is intentional and keeps capability reporting honest.
 */
export function getConfiguredRufloMcpClient(): RufloMcpClient | null {
  const baseUrl = process.env.RUFLO_MCP_URL?.trim();
  if (!baseUrl) return null;

  return createRufloMcpClient({
    baseUrl,
    token: process.env.RUFLO_MCP_TOKEN?.trim() || undefined,
    timeoutMs: Number(process.env.RUFLO_MCP_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  });
}
