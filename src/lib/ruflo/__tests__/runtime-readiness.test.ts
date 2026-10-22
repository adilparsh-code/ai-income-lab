// PHASE 5 — Ruflo orchestration readiness (OFFLINE ONLY).
//
// Every test here runs against a stubbed `fetch`. NO live Ruflo runtime is
// contacted and no credential is used. Passing these tests proves the
// receiver-side/orchestration-side CONTRACT is safe; it does NOT prove that a
// live Ruflo runtime works. The live verification checklist lives in
// docs/ruflo-live-verification-checklist.md.
//
// Covered:
//   - Missing / invalid RUFLO_MCP_URL and missing token fail clearly+safe.
//   - An ambiguous task creation RECONCILES instead of creating a duplicate.
//   - A definite failure is surfaced without a pointless reconciliation.
//   - Runtime unavailability never reports a task as created or completed.
//   - The bearer token never appears in an error message.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectTasksByIdempotencyKey,
  createRufloMcpClient,
  redactSecret,
  resolveRufloRuntimeConfig,
  RufloCallError,
  RufloUnknownOutcomeError,
  type RufloTaskRequest,
} from '../runtime-client';

const RUNTIME_URL = 'https://ruflo.example.com';
const TOKEN = 'super-secret-ruflo-token-value';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface RecordedCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  tool: string | null;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A JSON-RPC `tools/call` success carrying a payload in the content envelope. */
function toolResult(payload: unknown): unknown {
  return {
    jsonrpc: '2.0',
    result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
  };
}

interface StubOptions {
  /** Per-tool handler. Return a Response, or throw to simulate a transport failure. */
  onTool?: (tool: string, args: Record<string, unknown>) => Response | Promise<Response>;
  /** Status for the /health probe. */
  healthStatus?: number;
}

/** Install a stubbed fetch that records every outbound call. */
function stubFetch(options: StubOptions = {}) {
  const calls: RecordedCall[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const rawBody = typeof init?.body === 'string' ? init.body : null;
    let parsed: Record<string, unknown> | null = null;
    if (rawBody) {
      try {
        parsed = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }

    const isHealth = url.endsWith('/health');
    calls.push({
      url,
      method: (parsed?.method as string) ?? (isHealth ? 'GET' : 'POST'),
      body: parsed,
      tool: isHealth ? null : ((parsed?.params as { name?: string } | undefined)?.name ?? null),
    });

    if (isHealth) {
      return jsonResponse({ healthy: options.healthStatus ? false : true }, options.healthStatus ?? 200);
    }

    const method = parsed?.method;
    if (method === 'initialize') {
      return jsonResponse({ jsonrpc: '2.0', id: parsed?.id, result: { serverInfo: { name: 'claude-flow' } } });
    }

    const tool = (parsed?.params as { name?: string } | undefined)?.name ?? '';
    const toolArgs = (parsed?.params as { arguments?: Record<string, unknown> } | undefined)?.arguments ?? {};

    if (options.onTool) {
      return options.onTool(tool, toolArgs);
    }
    return jsonResponse(toolResult({ ok: true }));
  }) as typeof fetch;

  return calls;
}

function taskRequest(overrides: Partial<RufloTaskRequest> = {}): RufloTaskRequest {
  return {
    type: 'research',
    description: 'Investigate a candidate opportunity.',
    metadata: { correlationId: 'corr-1', idempotencyKey: 'idem-task-1' },
    ...overrides,
  };
}

function countToolCalls(calls: RecordedCall[], tool: string): number {
  return calls.filter((c) => c.tool === tool).length;
}

// ---------------------------------------------------------------------------
// Configuration — fail clearly and safely
// ---------------------------------------------------------------------------
describe('PHASE 5 Ruflo readiness — configuration', () => {
  it('reports a missing RUFLO_MCP_URL as "not configured", not as an error', () => {
    const resolution = resolveRufloRuntimeConfig({});
    assert.equal(resolution.ok, true);
    assert.equal(resolution.ok && resolution.configured, false);
    assert.equal(resolution.ok && resolution.client, null);
    assert.ok(resolution.ok && resolution.warnings.some((w) => w.includes('RUFLO_MCP_URL')));
  });

  it('rejects a non-http endpoint without echoing it', () => {
    const resolution = resolveRufloRuntimeConfig({ RUFLO_MCP_URL: 'file:///etc/passwd' });
    assert.equal(resolution.ok, false);
    if (resolution.ok) return;
    assert.ok(resolution.reason.includes('HTTP or HTTPS'));
    assert.ok(!resolution.reason.includes('file:///etc/passwd'));
  });

  it('rejects a private or loopback endpoint', () => {
    const resolution = resolveRufloRuntimeConfig({ RUFLO_MCP_URL: 'http://127.0.0.1:9000' });
    assert.equal(resolution.ok, false);
  });

  it('rejects an endpoint that embeds credentials', () => {
    const resolution = resolveRufloRuntimeConfig({
      RUFLO_MCP_URL: 'https://operator:hunter2@ruflo.example.com',
    });
    assert.equal(resolution.ok, false);
    if (resolution.ok) return;
    assert.ok(resolution.reason.includes('must not embed credentials'));
    assert.ok(!resolution.reason.includes('hunter2'));
  });

  it('warns when the token is missing but stays connected by default', () => {
    const resolution = resolveRufloRuntimeConfig({ RUFLO_MCP_URL: RUNTIME_URL });
    assert.equal(resolution.ok, true);
    assert.equal(resolution.ok && resolution.configured, true);
    assert.ok(resolution.ok && resolution.warnings.some((w) => w.includes('RUFLO_MCP_TOKEN')));
  });

  it('refuses to connect when the token is required but missing', () => {
    const resolution = resolveRufloRuntimeConfig({
      RUFLO_MCP_URL: RUNTIME_URL,
      RUFLO_MCP_REQUIRE_TOKEN: 'true',
    });
    assert.equal(resolution.ok, false);
    if (resolution.ok) return;
    assert.ok(resolution.reason.includes('RUFLO_MCP_TOKEN'));
    assert.ok(!resolution.reason.includes(TOKEN));
  });

  it('connects with a URL and token', () => {
    const resolution = resolveRufloRuntimeConfig({
      RUFLO_MCP_URL: RUNTIME_URL,
      RUFLO_MCP_TOKEN: TOKEN,
    });
    assert.equal(resolution.ok, true);
    assert.ok(resolution.ok && resolution.client);
  });
});

// ---------------------------------------------------------------------------
// Task creation — reconcile, never duplicate
// ---------------------------------------------------------------------------
describe('PHASE 5 Ruflo readiness — task creation', () => {
  it('creates a task once and reports it as created', async () => {
    const calls = stubFetch({
      onTool: (tool) => {
        if (tool === 'tasks/create') {
          return jsonResponse(toolResult({ taskId: 'task-1', status: 'queued', createdAt: 'now' }));
        }
        return jsonResponse(toolResult({}));
      },
    });

    const client = createRufloMcpClient({ baseUrl: RUNTIME_URL, token: TOKEN });
    const result = await client.createTaskWithReconciliation(taskRequest());

    assert.equal(result.reconciled, false);
    assert.equal(result.task.taskId, 'task-1');
    assert.equal(countToolCalls(calls, 'tasks/create'), 1);
  });

  it('reconciles an ambiguous create instead of creating a second task', async () => {
    const calls = stubFetch({
      onTool: (tool) => {
        if (tool === 'tasks/create') {
          // The runtime accepted the task but the response never arrived.
          throw new Error('socket hang up');
        }
        if (tool === 'tasks/list') {
          return jsonResponse(
            toolResult({
              tasks: [
                { taskId: 'task-99', status: 'queued', createdAt: 'now', metadata: { idempotencyKey: 'other-key' } },
                { taskId: 'task-42', status: 'queued', createdAt: 'now', metadata: { idempotencyKey: 'idem-task-1' } },
              ],
            }),
          );
        }
        return jsonResponse(toolResult({}));
      },
    });

    const client = createRufloMcpClient({ baseUrl: RUNTIME_URL, token: TOKEN });
    const result = await client.createTaskWithReconciliation(taskRequest());

    assert.equal(result.reconciled, true, 'the existing task must be recovered');
    assert.equal(result.task.taskId, 'task-42');
    assert.equal(
      countToolCalls(calls, 'tasks/create'),
      1,
      'exactly one create attempt — a reconciliation must never create a second task',
    );
    assert.equal(countToolCalls(calls, 'tasks/list'), 1);
  });

  it('refuses to guess when an ambiguous create cannot be reconciled', async () => {
    const calls = stubFetch({
      onTool: (tool) => {
        if (tool === 'tasks/create') throw new Error('socket hang up');
        if (tool === 'tasks/list') return jsonResponse(toolResult({ tasks: [] }));
        return jsonResponse(toolResult({}));
      },
    });

    const client = createRufloMcpClient({ baseUrl: RUNTIME_URL, token: TOKEN });
    await assert.rejects(
      () => client.createTaskWithReconciliation(taskRequest()),
      (error: unknown) => error instanceof RufloUnknownOutcomeError,
    );
    assert.equal(countToolCalls(calls, 'tasks/create'), 1);
  });

  it('does not reconcile after a definite failure', async () => {
    const calls = stubFetch({
      onTool: (tool) => {
        if (tool === 'tasks/create') return jsonResponse({ error: { message: 'invalid task' } }, 400);
        return jsonResponse(toolResult({}));
      },
    });

    const client = createRufloMcpClient({ baseUrl: RUNTIME_URL, token: TOKEN });
    await assert.rejects(
      () => client.createTaskWithReconciliation(taskRequest()),
      (error: unknown) => error instanceof RufloCallError && error.ambiguous === false,
    );
    assert.equal(countToolCalls(calls, 'tasks/list'), 0, 'a definite failure needs no reconciliation');
    assert.equal(countToolCalls(calls, 'tasks/create'), 1);
  });

  it('never reports a task as created when the runtime returns no task id', async () => {
    stubFetch({
      onTool: (tool) => {
        if (tool === 'tasks/create') return jsonResponse(toolResult({ status: 'queued' }));
        return jsonResponse(toolResult({}));
      },
    });

    const client = createRufloMcpClient({ baseUrl: RUNTIME_URL, token: TOKEN });
    await assert.rejects(
      () => client.createTask(taskRequest()),
      (error: unknown) => error instanceof RufloUnknownOutcomeError,
    );
  });

  it('reports runtime unavailability instead of a completed task', async () => {
    stubFetch({
      onTool: (tool) => {
        if (tool === 'tasks/create') return jsonResponse({ error: { message: 'runtime down' } }, 503);
        return jsonResponse(toolResult({}));
      },
    });

    const client = createRufloMcpClient({ baseUrl: RUNTIME_URL, token: TOKEN });
    await assert.rejects(
      () => client.createTask(taskRequest()),
      (error: unknown) => error instanceof RufloCallError,
    );
  });

  it('reports an unhealthy runtime through the health probe', async () => {
    stubFetch({ healthStatus: 503 });
    const client = createRufloMcpClient({ baseUrl: RUNTIME_URL, token: TOKEN });
    const health = await client.health();
    assert.equal(health.healthy, false);
    assert.equal(health.status, 503);
  });
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------
describe('PHASE 5 Ruflo readiness — secret handling', () => {
  it('never returns the bearer token in an error message', async () => {
    stubFetch({
      onTool: (tool) => {
        if (tool === 'tasks/create') {
          return jsonResponse({ error: { message: `upstream rejected token ${TOKEN}` } }, 401);
        }
        return jsonResponse(toolResult({}));
      },
    });

    const client = createRufloMcpClient({ baseUrl: RUNTIME_URL, token: TOKEN });
    await assert.rejects(
      () => client.createTask(taskRequest()),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(TOKEN), 'the token must never leak through an error');
        assert.ok(error.message.includes('[redacted]'));
        return true;
      },
    );
  });

  it('redacts a secret from arbitrary text', () => {
    const redacted = redactSecret(`token=${TOKEN} end`, TOKEN);
    assert.ok(!redacted.includes(TOKEN));
    assert.ok(redacted.includes('[redacted]'));
    assert.equal(redactSecret('nothing to hide', undefined), 'nothing to hide');
  });
});

// ---------------------------------------------------------------------------
// Reconciliation helper
// ---------------------------------------------------------------------------
describe('PHASE 5 Ruflo readiness — task lookup', () => {
  it('finds a task by idempotency key in a nested runtime response', () => {
    const payload = {
      data: {
        tasks: [
          { taskId: 'a', metadata: { idempotencyKey: 'k1' } },
          { taskId: 'b', metadata: { idempotencyKey: 'k2' } },
        ],
      },
    };
    const found = collectTasksByIdempotencyKey(payload, 'k2');
    assert.equal(found.length, 1);
    assert.equal(found[0].taskId, 'b');
  });

  it('returns nothing when no task matches', () => {
    const found = collectTasksByIdempotencyKey({ tasks: [{ taskId: 'a', metadata: { idempotencyKey: 'k1' } }] }, 'zz');
    assert.equal(found.length, 0);
  });

  it('looks a task up directly by idempotency key', async () => {
    const calls = stubFetch({
      onTool: (tool) => {
        if (tool === 'tasks/list') {
          return jsonResponse(toolResult({ tasks: [{ taskId: 't-7', metadata: { idempotencyKey: 'idem-task-1' } }] }));
        }
        return jsonResponse(toolResult({}));
      },
    });

    const client = createRufloMcpClient({ baseUrl: RUNTIME_URL, token: TOKEN });
    const found = await client.findTaskByIdempotencyKey('idem-task-1');
    assert.ok(found);
    assert.equal(found?.taskId, 't-7');
    assert.equal(countToolCalls(calls, 'tasks/create'), 0, 'a lookup must never create a task');
  });
});
