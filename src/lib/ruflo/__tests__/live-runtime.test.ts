import test from 'node:test';
import assert from 'node:assert/strict';
import { createRufloMcpClient } from '../runtime-client';

const baseUrl = process.env.RUFLO_LIVE_TEST_URL?.trim();

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

async function rpc(method: string, params: unknown, id: string): Promise<JsonRpcResponse> {
  const response = await fetch(`${baseUrl}/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.RUFLO_LIVE_TEST_TOKEN
        ? { Authorization: `Bearer ${process.env.RUFLO_LIVE_TEST_TOKEN}` }
        : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200, `${method} failed with HTTP ${response.status}`);
  return (await response.json()) as JsonRpcResponse;
}

test('live Ruflo V3 HTTP/MCP smoke test', { skip: !baseUrl }, async () => {
  const client = createRufloMcpClient({
    baseUrl: baseUrl!,
    token: process.env.RUFLO_LIVE_TEST_TOKEN?.trim() || undefined,
    timeoutMs: 10_000,
  });

  const health = await client.health();
  assert.equal(health.healthy, true, `Ruflo health check failed: HTTP ${health.status}`);

  // Protocol-level MCP initialize against the real server.
  const initialize = await rpc(
    'initialize',
    {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'ai-income-lab-ci', version: '5.7' },
    },
    'ci-init-1',
  );
  assert.equal(initialize.error, undefined, `initialize failed: ${JSON.stringify(initialize.error)}`);
  const serverInfo = initialize.result?.serverInfo as { name?: string; version?: string } | undefined;
  assert.match(String(serverInfo?.name || ''), /Claude-Flow/i);

  // tools/list over the initialized session.
  const tools = await rpc('tools/list', {}, 'ci-tools-1');
  assert.equal(tools.error, undefined, `tools/list failed: ${JSON.stringify(tools.error)}`);
  const toolNames = ((tools.result?.tools as { name: string }[] | undefined) ?? []).map((t) => t.name);
  assert.ok(toolNames.includes('tasks/create'), 'tasks/create tool must be registered');
  assert.ok(toolNames.includes('system/info'), 'system/info tool must be registered');

  // system/info through the AI Income Lab allowlisted client. The pinned
  // server's ADR-005 system/info reports name 'claude-flow' (verified live).
  const info = await client.callTool<{ name?: string; version?: string }>('system/info');
  assert.match(String(info?.name || ''), /claude-flow/i);
  assert.equal(typeof info?.version, 'string');

  const task = await client.createTask({
    type: 'test',
    description: 'AI Income Lab non-destructive Ruflo integration smoke test. Do not execute shell commands or modify files.',
    priority: 1,
    metadata: {
      correlationId: 'ci-ruflo-smoke',
      idempotencyKey: 'ci-ruflo-smoke-v1',
    },
  });

  assert.equal(typeof task.taskId, 'string');
  assert.ok(task.taskId.length > 0);
  assert.equal(typeof task.status, 'string');
});
