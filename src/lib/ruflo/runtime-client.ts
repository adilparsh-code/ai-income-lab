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
import { isAllowedResearchUrl } from '@/lib/research/core';

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
  /**
   * Create a task, and RECONCILE instead of blindly recreating when the
   * outcome of the create call is ambiguous (timeout, network interruption,
   * 5xx). Returns the existing task when the runtime already has one for the
   * same idempotency key. Never issues a second `tasks/create`.
   */
  createTaskWithReconciliation(request: RufloTaskRequest): Promise<RufloTaskCreationResult>;
  /** Find an existing task by its idempotency key, if the runtime has one. */
  findTaskByIdempotencyKey(idempotencyKey: string): Promise<TypedTaskResult | null>;
}

export interface TypedTaskResult {
  taskId: string;
  status: string;
  createdAt: string;
  queuePosition?: number;
}

/** The outcome of a task creation, including whether it was reconciled. */
export interface RufloTaskCreationResult {
  task: TypedTaskResult;
  /** True when the task already existed and was recovered, not created. */
  reconciled: boolean;
}

/**
 * A failed Ruflo call.
 *
 * `ambiguous` is the important field: it means the call may or may not have
 * taken effect on the runtime (timeout, network interruption, 5xx). An
 * ambiguous failure MUST be reconciled, never blindly retried with a fresh
 * `tasks/create`, because that would create a duplicate task.
 */
export class RufloCallError extends Error {
  readonly status: number | undefined;
  readonly ambiguous: boolean;

  constructor(message: string, status?: number, ambiguous = false) {
    super(message);
    this.name = 'RufloCallError';
    this.status = status;
    this.ambiguous = ambiguous;
  }
}

/**
 * Raised when a task creation's outcome could not be determined AND no
 * existing task was found to reconcile against. The caller must NOT assume
 * the task was created, and must NOT blindly create another one.
 */
export class RufloUnknownOutcomeError extends Error {
  readonly idempotencyKey: string;

  constructor(idempotencyKey: string, detail: string) {
    super(
      `Ruflo task creation outcome is unknown and no task with this idempotency key was found. ${detail}`,
    );
    this.name = 'RufloUnknownOutcomeError';
    this.idempotencyKey = idempotencyKey;
  }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Ruflo runtime URL must use HTTP or HTTPS.');
  }
  // Credentials embedded in the URL (http://user:pass@host) would end up in
  // error messages, logs and process listings. Refuse them outright — the
  // bearer token is the only supported way to authenticate.
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error('Ruflo runtime URL must not embed credentials. Use the bearer token instead.');
  }
  // PHASE 11.8 SSRF hardening: this base URL comes from RUFLO_RUNTIME_URL
  // configuration, but a mis-set or attacker-influenced value would otherwise
  // let the server reach link-local addresses (including the 169.254.169.254
  // cloud metadata endpoint) or RFC1918 space. Reuse the EXISTING research URL
  // guard rather than writing a second, weaker SSRF list.
  //
  // Loopback is exempted ONLY for the explicit live-smoke-test job, which
  // intentionally points RUFLO_LIVE_TEST_URL at a locally-started server. That
  // exemption is scoped to the CI flag below and never applies to a normal
  // deployment, so the production path keeps the full guard.
  if (!isAllowedResearchUrl(url.toString()) && !(ALLOW_LOOPBACK && isLoopbackUrl(url))) {
    throw new Error(
      'Ruflo runtime URL must be a public http(s) URL. Loopback, private and link-local hosts are refused.',
    );
  }
  return url.toString().replace(/\/$/, '');
}

/**
 * Only the live smoke-test CI job may address a loopback host. The flag is
 * derived from the presence of the live-test-specific variable, so no
 * production deployment sets it.
 */
const ALLOW_LOOPBACK = typeof process.env.RUFLO_LIVE_TEST_URL === 'string'
  && process.env.RUFLO_LIVE_TEST_URL.trim().length > 0;

function isLoopbackUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function timeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(Math.min(Math.max(timeoutMs, 1_000), MAX_TIMEOUT_MS));
}

function authHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Remove the bearer token from any text that may be surfaced to a caller or
 * written to a log. The runtime is remote: an error message it returns is
 * untrusted text and must never carry our credential back out.
 */
export function redactSecret(text: string, secret?: string): string {
  if (!secret) return text;
  if (!text.includes(secret)) return text;
  return text.split(secret).join('[redacted]');
}

/** A safe, credential-free description of a thrown value. */
function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return 'the request timed out';
    }
    return error.message;
  }
  return 'an unknown error occurred';
}

async function requestJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: timeoutSignal(timeoutMs),
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
      cache: 'no-store',
    });
  } catch (error) {
    // No response was received. The call may or may not have taken effect on
    // the runtime, so the failure is AMBIGUOUS: it must be reconciled, not
    // blindly retried.
    throw new RufloCallError(
      `Ruflo request failed before a response was received (${safeErrorMessage(error)}).`,
      undefined,
      true,
    );
  }

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

/**
 * MCP tools/call results arrive wrapped in the standard content envelope
 * ({ content: [{ type: 'text', text: '<json>' }], isError? }). Ruflo V3's
 * tool handlers return their JSON payload inside that envelope, so unwrap
 * it here; a bare result (older shape) passes through unchanged.
 */
function unwrapMcpToolResult<T>(result: unknown): T {
  if (
    result &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    Array.isArray((result as { content?: unknown }).content)
  ) {
    const content = (result as { content: unknown[] }).content;
    const textItem = content.find(
      (item) =>
        item &&
        typeof item === 'object' &&
        (item as { type?: unknown }).type === 'text' &&
        typeof (item as { text?: unknown }).text === 'string',
    ) as { text: string } | undefined;
    if (textItem) {
      try {
        return JSON.parse(textItem.text) as T;
      } catch {
        return textItem.text as unknown as T;
      }
    }
  }
  return result as T;
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
      throw new RufloCallError(
        `Ruflo initialize failed (HTTP ${initialize.status}).`,
        initialize.status,
        initialize.status >= 500,
      );
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

    const envelope = result.body as { result?: unknown; error?: { message?: string } } | null;

    if (envelope?.error) {
      // The runtime's message is untrusted text: it must never carry our
      // bearer token back out to a caller or a log line.
      const message = redactSecret(
        (envelope.error.message || 'Ruflo tool call failed.').slice(0, 300),
        config.token,
      );
      throw new RufloCallError(message, result.status, result.status >= 500);
    }

    if (result.status < 200 || result.status >= 300) {
      throw new RufloCallError(
        `Ruflo tool call failed (HTTP ${result.status}).`,
        result.status,
        result.status >= 500,
      );
    }

    return unwrapMcpToolResult<T>(envelope?.result);
  }

  async function createTask(request: RufloTaskRequest): Promise<TypedTaskResult> {
    const description = request.description.trim().slice(0, MAX_DESCRIPTION_LENGTH);
    if (!description) throw new Error('Ruflo task description is required.');

    const priority = Math.min(Math.max(request.priority ?? 5, 1), 10);
    const timeout = request.timeout
      ? Math.min(Math.max(request.timeout, 1_000), MAX_TIMEOUT_MS)
      : undefined;

    const created = await callTool<TypedTaskResult>('tasks/create', {
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

    // A response without a task id is NOT a created task. Reporting it as one
    // would let a caller believe work exists that the runtime never accepted.
    if (
      !created ||
      typeof created.taskId !== 'string' ||
      created.taskId.trim().length === 0
    ) {
      throw new RufloUnknownOutcomeError(
        request.metadata.idempotencyKey,
        'The runtime did not return a task id, so no task can be confirmed.',
      );
    }

    return {
      ...created,
      status: typeof created.status === 'string' ? created.status : 'UNKNOWN',
      createdAt: typeof created.createdAt === 'string' ? created.createdAt : '',
    };
  }

  /**
   * Find a task the runtime already holds for an idempotency key.
   *
   * The search is deliberately tolerant of the runtime's response shape: it
   * walks the decoded JSON and collects every object that carries both a
   * `taskId` and a matching `metadata.idempotencyKey`. The exact envelope
   * shape differs between Ruflo versions; the invariant we depend on does
   * not.
   */
  async function findTaskByIdempotencyKey(idempotencyKey: string): Promise<TypedTaskResult | null> {
    const listed = await callTool<unknown>('tasks/list', { limit: 100 });
    const matches = collectTasksByIdempotencyKey(listed, idempotencyKey);
    return matches.length > 0 ? matches[0] : null;
  }

  /**
   * Create a task, reconciling instead of recreating when the outcome is
   * ambiguous.
   *
   * Exactly ONE `tasks/create` is ever issued for a given attempt. If that
   * call fails ambiguously, the runtime is queried for an existing task with
   * the same idempotency key. A found task is returned (reconciled); a task
   * that cannot be found yields RufloUnknownOutcomeError — never a silent
   * second creation.
   */
  async function createTaskWithReconciliation(
    request: RufloTaskRequest,
  ): Promise<RufloTaskCreationResult> {
    try {
      const task = await createTask(request);
      return { task, reconciled: false };
    } catch (error) {
      const ambiguous = error instanceof RufloCallError && error.ambiguous;
      if (!ambiguous) {
        // A definite failure (validation, 4xx) is safe to surface directly.
        throw error;
      }

      let existing: TypedTaskResult | null = null;
      try {
        existing = await findTaskByIdempotencyKey(request.metadata.idempotencyKey);
      } catch {
        existing = null;
      }

      if (existing) {
        return { task: existing, reconciled: true };
      }

      throw new RufloUnknownOutcomeError(
        request.metadata.idempotencyKey,
        'The runtime could not be queried for an existing task. No second task was created.',
      );
    }
  }

  return {
    health,
    callTool,
    createTask,
    createTaskWithReconciliation,
    findTaskByIdempotencyKey,
  };
}

/**
 * Collect every task-like object in an arbitrary JSON value whose
 * `metadata.idempotencyKey` matches. Used for reconciliation lookups.
 */
export function collectTasksByIdempotencyKey(
  value: unknown,
  idempotencyKey: string,
  found: TypedTaskResult[] = [],
  depth = 0,
): TypedTaskResult[] {
  if (depth > 8 || found.length >= 20) return found;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTasksByIdempotencyKey(item, idempotencyKey, found, depth + 1);
    }
    return found;
  }
  if (!value || typeof value !== 'object') return found;

  const record = value as Record<string, unknown>;
  const metadata = record.metadata as Record<string, unknown> | undefined;
  if (
    typeof record.taskId === 'string' &&
    record.taskId.length > 0 &&
    metadata &&
    typeof metadata === 'object' &&
    metadata.idempotencyKey === idempotencyKey
  ) {
    found.push({
      taskId: record.taskId,
      status: typeof record.status === 'string' ? record.status : 'UNKNOWN',
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
      ...(typeof record.queuePosition === 'number' ? { queuePosition: record.queuePosition } : {}),
    });
    return found;
  }

  for (const nested of Object.values(record)) {
    collectTasksByIdempotencyKey(nested, idempotencyKey, found, depth + 1);
  }
  return found;
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

// ---------------------------------------------------------------------------
// Configuration resolution (fail clearly, fail safely)
// ---------------------------------------------------------------------------

export type RufloConfigResolution =
  | {
      ok: true;
      /** The client, or null when Ruflo is simply not configured. */
      client: RufloMcpClient | null;
      configured: boolean;
      /** Non-fatal configuration observations (e.g. a missing token). */
      warnings: string[];
    }
  | {
      ok: false;
      configured: boolean;
      /** A safe, credential-free explanation. Never contains the URL or token. */
      reason: string;
    };

/**
 * Resolve the Ruflo runtime configuration WITHOUT throwing.
 *
 * The distinction matters: a mis-configured endpoint must produce a clear,
 * safe refusal — not an unhandled exception that could crash a startup path
 * or leak the configured URL (which may contain a hostname an operator would
 * rather not have logged).
 */
export function resolveRufloRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): RufloConfigResolution {
  const rawUrl = env.RUFLO_MCP_URL?.trim();
  if (!rawUrl) {
    return {
      ok: true,
      client: null,
      configured: false,
      warnings: ['RUFLO_MCP_URL is not configured; Ruflo remains disconnected.'],
    };
  }

  const token = env.RUFLO_MCP_TOKEN?.trim() || undefined;
  const warnings: string[] = [];

  let client: RufloMcpClient;
  try {
    client = createRufloMcpClient({
      baseUrl: rawUrl,
      token,
      timeoutMs: Number(env.RUFLO_MCP_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      configured: true,
      reason:
        'RUFLO_MCP_URL is invalid and was rejected. '
        + `${error instanceof Error ? error.message : 'The URL could not be parsed.'} `
        + 'Ruflo remains disconnected.',
    };
  }

  if (!token) {
    const requireToken = (env.RUFLO_MCP_REQUIRE_TOKEN ?? '').trim().toLowerCase();
    if (requireToken === 'true' || requireToken === '1' || requireToken === 'yes') {
      return {
        ok: false,
        configured: true,
        reason:
          'RUFLO_MCP_TOKEN is required (RUFLO_MCP_REQUIRE_TOKEN is enabled) but is not configured. '
          + 'Ruflo remains disconnected.',
      };
    }
    warnings.push(
      'RUFLO_MCP_TOKEN is not configured; requests to the Ruflo runtime are unauthenticated.',
    );
  }

  return { ok: true, client, configured: true, warnings };
}
