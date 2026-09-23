import test from 'node:test';
import assert from 'node:assert/strict';
import { createRufloMcpClient } from '../runtime-client';

const baseUrl = process.env.RUFLO_LIVE_TEST_URL?.trim();

test('live Ruflo V3 HTTP/MCP smoke test', { skip: !baseUrl }, async () => {
  const client = createRufloMcpClient({
    baseUrl: baseUrl!,
    token: process.env.RUFLO_LIVE_TEST_TOKEN?.trim() || undefined,
    timeoutMs: 10_000,
  });

  const health = await client.health();
  assert.equal(health.healthy, true, `Ruflo health check failed: HTTP ${health.status}`);

  const info = await client.callTool<{ name?: string; version?: string }>('system/info');
  assert.match(String(info?.name || ''), /Claude-Flow MCP Server V3/i);
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
