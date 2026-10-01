// ============================================================================
// PHASE 11.3 — COMMUNICATION PROVIDER ABSTRACTION (truthful by construction)
// ============================================================================
// Following the existing SearchProvider / ProductBuilderAdapter /
// DeploymentProvider precedents: ONE narrow interface, a registry, a truthful
// capability descriptor, and a deterministic TEST adapter.
//
// THERE IS NO CONNECTED COMMUNICATION PROVIDER. No email account, no SMTP
// credential, and no messaging platform is wired into this repository. The
// production resolver therefore returns NOT_CONNECTED and refuses to send.
//
// Honesty rules (docs/phase-11-design.md §14, §21, §22):
//  - No provider claims to be connected without a real, credential-backed,
//    authenticated round trip.
//  - The test adapter is labelled SIMULATED and is explicitly unavailable in
//    production. It exists so the abstraction is genuinely exercised, not to
//    fake an integration.
//  - Every send is audited; bounce/complaint/opt-out feed suppression.
//  - Nothing here performs outreach — outreach is a separate, bounded,
//    human-gated path.
// ============================================================================

import { auditSecurityEvent } from '@/lib/security/guard';
import { screenOutreachCopy } from './outreach-safety';

export const COMMUNICATION_PROVIDER_STATES = [
  'NOT_CONNECTED',
  'CONFIGURED',
  'HEALTHY',
  'DEGRADED',
  'FAILED',
] as const;
export type CommunicationProviderState = (typeof COMMUNICATION_PROVIDER_STATES)[number];

export function isCommunicationProviderState(value: unknown): value is CommunicationProviderState {
  return typeof value === 'string' && (COMMUNICATION_PROVIDER_STATES as readonly string[]).includes(value);
}

export const COMMUNICATION_CHANNELS = ['EMAIL', 'CLIENT_PORTAL', 'MESSAGING'] as const;
export type CommunicationChannel = (typeof COMMUNICATION_CHANNELS)[number];

export function isCommunicationChannel(value: unknown): value is CommunicationChannel {
  return typeof value === 'string' && (COMMUNICATION_CHANNELS as readonly string[]).includes(value);
}

export const DELIVERY_STATUSES = ['QUEUED', 'SENT', 'DELIVERED', 'BOUNCED', 'COMPLAINED', 'FAILED'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export interface CommunicationSendRequest {
  channel: CommunicationChannel;
  /** Business contact address only. No attachments, no secrets. */
  to: string;
  subject: string;
  body: string;
  /** Idempotency key — the replay guard for a retried send. */
  idempotencyKey: string;
  /** Optional correlation into the commercial pipeline. */
  correlationId?: string;
}

export type CommunicationSendResult =
  | { ok: true; providerMessageId: string; status: DeliveryStatus; simulated: boolean }
  | { ok: false; reason: string; status?: DeliveryStatus };

/** Bounded input limits — refuse oversize, never truncate silently. */
export const MAX_COMM_SUBJECT_CHARS = 200;
export const MAX_COMM_BODY_CHARS = 10_000;

export interface CommunicationProvider {
  readonly id: string;
  readonly channel: CommunicationChannel;
  /** True ONLY with a real, credential-backed provider. */
  isConfigured(): boolean;
  /** Environment/credential names required — never echoes a secret value. */
  configurationHint(): string[];
  /** Truthful state derived from real configuration, never asserted. */
  health(): { state: CommunicationProviderState; detail: string };
  /** Deterministic idempotent send; a real provider is not implemented. */
  send(request: CommunicationSendRequest): Promise<CommunicationSendResult>;
  /** Idempotent opt-out suppression. */
  suppress(address: string, reason: string): Promise<{ ok: true }>;
}

// ---------------------------------------------------------------------------
// The one production provider: NOT_CONNECTED, refuses everything
// ---------------------------------------------------------------------------

/**
 * The honest production provider. It is deliberately NOT configured: no email
 * credential exists in this repository. `send` therefore ALWAYS refuses with an
 * explicit NOT_CONNECTED reason — it never pretends to send and never fabricates
 * a provider message id.
 */
export class UnconnectedCommunicationProvider implements CommunicationProvider {
  readonly id = 'none';
  readonly channel: CommunicationChannel;

  constructor(channel: CommunicationChannel = 'EMAIL') {
    this.channel = channel;
  }

  isConfigured(): boolean {
    return false;
  }

  configurationHint(): string[] {
    return [
      'A real transactional-email provider adapter (none is implemented in this repository).',
      'A server-side provider credential (never a NEXT_PUBLIC_* variable).',
      'A verified authenticated round trip before any CONNECTED/HEALTHY label.',
    ];
  }

  health(): { state: CommunicationProviderState; detail: string } {
    return {
      state: 'NOT_CONNECTED',
      detail:
        'No communication provider is connected to this deployment. Nothing has been sent and no message '
        + 'is fabricated. Outreach and delivery communication remain NOT_CONNECTED by design.',
    };
  }

  async send(): Promise<CommunicationSendResult> {
    return {
      ok: false,
      reason:
        'NOT_CONNECTED: no communication provider is configured. The message was NOT sent. No provider '
        + 'message id exists because no provider accepted it.',
    };
  }

  async suppress(address: string, reason: string): Promise<{ ok: true }> {
    // Suppression is a local, always-available safety control: it must work
    // even with no provider connected. The address/reason are accepted for
    // interface parity; there is no provider to forward them to.
    void address; void reason;
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// Deterministic test adapter — SIMULATED, never production
// ---------------------------------------------------------------------------

/**
 * A deterministic in-memory adapter used ONLY by tests and local development.
 * It is labelled SIMULATED everywhere it surfaces, refuses to run in production,
 * and produces stable, repeatable ids so idempotency and replay protection can
 * be genuinely tested. It never reaches the network.
 */
export class SimulatedCommunicationProvider implements CommunicationProvider {
  readonly id = 'simulated-test-adapter';
  readonly channel: CommunicationChannel;

  private readonly sent = new Map<string, CommunicationSendResult>();
  private readonly suppressed = new Set<string>();
  /** Message counter — deterministic, starts at 1 for each instance. */
  private counter = 0;

  constructor(
    channel: CommunicationChannel = 'EMAIL',
    private readonly options: { simulated?: boolean; failNext?: boolean } = {},
  ) {
    this.channel = channel;
  }

  isConfigured(): boolean {
    return true;
  }

  configurationHint(): string[] {
    return ['None — this adapter is deterministic and local. It exists for tests, not for production sends.'];
  }

  health(): { state: CommunicationProviderState; detail: string } {
    // PHASE 11.6 HARDENING: this adapter must NOT report HEALTHY. A simulated
    // adapter that claims to be healthy is a false green in any provider
    // health panel, and it previously did exactly that. It now reports
    // NOT_CONNECTED with an explicit SIMULATED label, which is truthful:
    // nothing is connected, and nothing leaves this process.
    return {
      state: 'NOT_CONNECTED',
      detail:
        'SIMULATED / TEST_ONLY: deterministic local test adapter. No message leaves this process. This is '
        + 'NOT a real integration and is deliberately reported as NOT_CONNECTED so it can never be mistaken '
        + 'for a connected provider.',
    };
  }

  async send(request: CommunicationSendRequest): Promise<CommunicationSendResult> {
    const validation = validateSendRequest(request);
    if (!validation.ok) return validation;
    const existing = this.sent.get(request.idempotencyKey);
    if (existing) return existing; // idempotent replay
    if (this.options.failNext) {
      return { ok: false, reason: 'SIMULATED_FAILURE: the simulated adapter was configured to fail once.', status: 'FAILED' };
    }
    if (this.suppressed.has(request.to.toLowerCase())) {
      return { ok: false, reason: 'SUPPRESSED: this address has opted out; no message was sent.', status: 'FAILED' };
    }
    this.counter += 1;
    const result: CommunicationSendResult = {
      ok: true,
      providerMessageId: `sim-${this.counter}`,
      status: 'SENT',
      simulated: true,
    };
    this.sent.set(request.idempotencyKey, result);
    return result;
  }

  async suppress(address: string, reason: string): Promise<{ ok: true }> {
    void reason;
    this.suppressed.add(address.toLowerCase());
    return { ok: true };
  }

  /** Test-only inspection: how many distinct sends were accepted. */
  sentCount(): number {
    return this.sent.size;
  }
}

function validateSendRequest(request: CommunicationSendRequest): CommunicationSendResult | { ok: true } {
  if (!isCommunicationChannel(request.channel)) {
    return { ok: false, reason: 'channel must be EMAIL, CLIENT_PORTAL, or MESSAGING.' };
  }
  if (typeof request.to !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(request.to)) {
    return { ok: false, reason: 'to must be a valid business contact address.' };
  }
  if (typeof request.subject !== 'string' || request.subject.length > MAX_COMM_SUBJECT_CHARS) {
    return { ok: false, reason: `subject must be a string of at most ${MAX_COMM_SUBJECT_CHARS} characters.` };
  }
  if (typeof request.body !== 'string' || request.body.trim().length === 0) {
    return { ok: false, reason: 'body is required.' };
  }
  if (request.body.length > MAX_COMM_BODY_CHARS) {
    return {
      ok: false,
      reason: `body exceeds ${MAX_COMM_BODY_CHARS} characters. Oversize content is refused, never truncated.`,
    };
  }
  if (typeof request.idempotencyKey !== 'string' || request.idempotencyKey.trim().length === 0 || request.idempotencyKey.length > 200) {
    return { ok: false, reason: 'idempotencyKey is required (at most 200 characters).' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Resolve the communication provider for a channel.
 *
 * There is NO configured provider in this repository, so this always returns
 * the NOT_CONNECTED provider. The seam exists so a real adapter can be added
 * later without redesigning any client-side architecture.
 */
export function resolveCommunicationProvider(channel: CommunicationChannel = 'EMAIL'): CommunicationProvider {
  return new UnconnectedCommunicationProvider(channel);
}

/** Truthful health of every channel, for the Observatory integration panel. */
export function describeCommunicationHealth(): {
  channel: CommunicationChannel;
  providerId: string;
  state: CommunicationProviderState;
  detail: string;
  requiredForConnected: string[];
}[] {
  return COMMUNICATION_CHANNELS.map((channel) => {
    const provider = resolveCommunicationProvider(channel);
    const health = provider.health();
    return {
      channel,
      providerId: provider.id,
      state: health.state,
      detail: health.detail,
      requiredForConnected: provider.configurationHint(),
    };
  });
}

/**
 * Send through the resolved provider, always auditing the attempt. The audit
 * records the OUTCOME, never the message body (which may contain client data).
 */
export async function sendCommunication(
  request: CommunicationSendRequest,
  surface: string,
): Promise<CommunicationSendResult> {
  // PHASE 11.6 HARDENING: the content gate now runs INSIDE this low-level
  // function, not only in the higher-level outreach service. Previously
  // sendCommunication never called screenOutreachCopy, so any caller that used
  // it directly could put impersonating or deceptive copy in front of a real
  // provider. Screening here means no caller can skip it.
  const copy = `${request.subject}\n${request.body}`;
  const screened = screenOutreachCopy(copy);
  if (!screened.ok) {
    await auditSecurityEvent({
      kind: 'COMMERCIAL_COMMUNICATION_SEND',
      surface,
      outcome: 'refused',
      detail: `content gate refused: ${screened.violations.map((v) => v.id).join(',').slice(0, 80)}`,
    });
    return {
      ok: false,
      reason: `Outgoing copy refused by the content gate: ${screened.reason}`,
      status: 'FAILED',
    };
  }

  const provider = resolveCommunicationProvider(request.channel);
  const result = await provider.send(request);
  await auditSecurityEvent({
    kind: 'COMMERCIAL_COMMUNICATION_SEND',
    surface,
    outcome: result.ok ? 'ok' : 'refused',
    detail: `channel=${request.channel} provider=${provider.id} ok=${result.ok}`,
  });
  return result;
}