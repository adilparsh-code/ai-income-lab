// PHASE 4 — Producer ↔ receiver contract tests (RECEIVER SIDE ONLY).
//
// These tests pin the receiver half of the handoff contract. The producer
// lives in a SEPARATE repository/worktree and is NOT exercised here; nothing
// in this file should be read as evidence of an end-to-end integration run.
//
// What is verified:
//   - Duplicate delivery IDs collapse to one execution.
//   - A LEGACY row (written before the content digest existed) is still
//     classified correctly instead of being silently trusted.
//   - The same idempotency key with DIFFERENT content is a CONFLICT, and the
//     original delivery is left untouched.
//   - A lost response (producer timeout after the receiver committed) is
//     resolved by reconciliation, never by a second execution.
//   - A failed / blocked / review-required / degraded record is NEVER
//     acknowledged as successfully processed, on the first attempt or on replay.
//   - Ambiguous persistence is reported as an error, not as a success.
//   - The HTTP boundary answers 429 with a Retry-After the producer can honour.
//
// The producer-side assumptions that still need a separate integration run are
// listed in docs/handoff-producer-receiver-contract.md.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JobOutcome, JobStatus, JobType } from '@/lib/jobs/types';
import { validateJobPayload } from '@/lib/jobs/job-definitions';
import type { HandoffDb, HandoffRunJob } from '../handoff-receiver';
import { installTestDatabase } from '@/test-utils/install-test-database';

const tempDir = mkdtempSync(join(tmpdir(), 'aill-handoff-contract-'));
Object.assign(process.env, {
  DATABASE_URL: 'file:' + join(tempDir, 'test.db'),
  NODE_ENV: 'test',
  OPERATOR_CONTROL_TOKEN: 'test-operator-token-value',
});

before(() => {
  installTestDatabase(join(tempDir, 'test.db'));
});

after(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* tmp cleanup best-effort */
  }
});

type ReceiverModule = typeof import('../handoff-receiver');
let receiver: ReceiverModule;

before(async () => {
  receiver = await import('../handoff-receiver');
});

function validEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: '1.0',
    contractId: 'contract-abc-1',
    idempotencyKey: 'idem-1',
    correlationId: 'corr-1',
    eventType: 'OPPORTUNITY_PROPOSED',
    title: 'Niche research newsletter',
    description: 'A curated weekly newsletter about practical automation topics.',
    category: 'MEDIA',
    businessModel: 'SUBSCRIPTION',
    monetizationMethod: 'PAID_SUBSCRIPTION',
    assertedEligibility: 'ALLOWED',
    payload: { notes: 'plain data only' },
    ...overrides,
  };
}

interface FakeOptions {
  /** Throw on the reservation INSERT (simulates ambiguous persistence). */
  failCreate?: boolean;
  /** Make findUnique return null even when a row exists. */
  hideRows?: boolean;
}

/** In-memory HandoffDb that enforces the unique idempotencyKey, like the real one. */
function makeFakeDb(options: FakeOptions = {}) {
  const rows = new Map<string, Record<string, unknown>>();
  const events: { kind: string; outcome: string; detail: string | null }[] = [];
  let nextId = 1;
  return {
    rows,
    events,
    db: {
      opportunityHandoff: {
        async findUnique({ where }: { where: { idempotencyKey: string } }) {
          if (options.hideRows) return null;
          const found = rows.get(where.idempotencyKey);
          return (found as never) ?? null;
        },
        async create({ data }: { data: Record<string, unknown> }) {
          if (options.failCreate) {
            throw new Error('connection reset while committing the reservation');
          }
          if (rows.has(String(data.idempotencyKey))) {
            throw new Error('Unique constraint failed on idempotencyKey');
          }
          const row = {
            id: `handoff-${nextId++}`,
            jobRunId: null,
            opportunityId: null,
            ...data,
          };
          rows.set(String(data.idempotencyKey), row);
          return row as never;
        },
        async update({ where, data }: { where: { idempotencyKey: string }; data: Record<string, unknown> }) {
          const row = rows.get(where.idempotencyKey);
          if (!row) throw new Error('not found');
          Object.assign(row, data);
          return row as never;
        },
      },
      securityEvent: {
        async create({ data }: { data: { kind: string; outcome: string; detail?: string | null } }) {
          events.push({ kind: data.kind, outcome: data.outcome, detail: data.detail ?? null });
          return {};
        },
      },
    },
  };
}

/** A runJob that reports a specific terminal status. */
function jobWithStatus(status: JobStatus, jobId = 'job-run-1') {
  const calls: { jobType: string; payload: Record<string, unknown>; correlationId: string }[] = [];
  const runJob: HandoffRunJob = async (
    jobType: JobType,
    payload: Record<string, unknown>,
    correlationId: string,
  ) => {
    const validation = validateJobPayload(jobType, payload);
    if (!validation.valid) {
      throw new Error(`fake runJob: payload failed the real Job Runner contract: ${validation.errors.join('; ')}`);
    }
    calls.push({ jobType, payload, correlationId });
    return {
      jobId,
      jobType,
      status,
      deduplicated: false,
      result: { opportunityId: 'opp-1' },
      error: null,
      executionMode: 'MOCKED',
      retryCount: 0,
    } satisfies JobOutcome;
  };
  return { calls, runJob };
}

function options(fake: ReturnType<typeof makeFakeDb>, runJob: HandoffRunJob) {
  return { db: fake.db as unknown as HandoffDb, senderIdentity: 'sender-fingerprint', runJob };
}

/**
 * Read the verdict fields regardless of which branch of the result union it
 * is. `assert.equal(result.ok, false)` narrows the union, so the fields have
 * to be read BEFORE such an assertion.
 */
function verdictOf(result: Awaited<ReturnType<typeof receiver.receiveHandoff>>) {
  return {
    ok: result.ok,
    status: result.status,
    handoff: result.ok ? result.handoff : (result.handoff ?? 'UNKNOWN'),
    duplicate: result.ok ? result.duplicate : false,
  };
}

// ---------------------------------------------------------------------------
// Duplicate delivery IDs
// ---------------------------------------------------------------------------
describe('PHASE 4 receiver contract — duplicate delivery IDs', () => {
  it('executes once no matter how many times the same delivery arrives', async () => {
    const fake = makeFakeDb();
    const { calls, runJob } = jobWithStatus('SUCCEEDED');

    const results = [];
    for (let i = 0; i < 5; i += 1) {
      results.push(await receiver.receiveHandoff(validEnvelope(), options(fake, runJob)));
    }

    assert.equal(calls.length, 1, 'the Job Runner must run exactly once');
    assert.equal(fake.rows.size, 1, 'exactly one durable row');
    assert.equal(results[0].ok && results[0].handoff, 'ACCEPTED');
    for (const later of results.slice(1)) {
      assert.equal(later.ok && later.handoff, 'DUPLICATE');
      assert.equal(later.ok && later.duplicate, true);
      assert.equal(later.ok && later.status, 200);
    }
  });

  it('reports a replay as a duplicate only while the original is genuinely accepted', async () => {
    const fake = makeFakeDb();
    const { runJob } = jobWithStatus('SUCCEEDED');
    await receiver.receiveHandoff(validEnvelope(), options(fake, runJob));
    const row = fake.rows.get('idem-1') as Record<string, unknown>;
    // The JobRun pointer is what makes an ACCEPTED row trustworthy.
    assert.equal(row.jobRunId, 'job-run-1');
    assert.equal(row.status, 'ACCEPTED');
  });
});

// ---------------------------------------------------------------------------
// Legacy rows (no immutable content snapshot)
// ---------------------------------------------------------------------------
describe('PHASE 4 receiver contract — legacy rows without a content digest', () => {
  it('honours a legacy replay when the comparable fields still match', async () => {
    const fake = makeFakeDb();
    const { calls, runJob } = jobWithStatus('SUCCEEDED');
    await receiver.receiveHandoff(validEnvelope(), options(fake, runJob));

    // Simulate a row written by an OLDER receiver: the raw payload object,
    // with no {v, contentDigest, payload} wrapper.
    const row = fake.rows.get('idem-1') as Record<string, unknown>;
    row.payloadJson = JSON.stringify({ notes: 'plain data only' });

    const replay = await receiver.receiveHandoff(validEnvelope(), options(fake, runJob));
    assert.equal(replay.ok, true);
    assert.equal(replay.ok && replay.handoff, 'DUPLICATE');
    assert.equal(calls.length, 1);
  });

  it('still detects a conflict on a legacy row when a comparable field differs', async () => {
    const fake = makeFakeDb();
    const { calls, runJob } = jobWithStatus('SUCCEEDED');
    await receiver.receiveHandoff(validEnvelope(), options(fake, runJob));

    const row = fake.rows.get('idem-1') as Record<string, unknown>;
    row.payloadJson = JSON.stringify({ notes: 'plain data only' });

    const conflict = await receiver.receiveHandoff(
      validEnvelope({ title: 'A completely different proposal' }),
      options(fake, runJob),
    );
    assert.equal(conflict.ok, false);
    assert.equal(!conflict.ok && conflict.handoff, 'CONFLICT');
    assert.equal(!conflict.ok && conflict.status, 409);
    assert.equal(calls.length, 1, 'a conflict must not dispatch work');
  });
});

// ---------------------------------------------------------------------------
// Conflicting content for the same idempotency key
// ---------------------------------------------------------------------------
describe('PHASE 4 receiver contract — conflicting content', () => {
  it('refuses a reused idempotency key carrying different content', async () => {
    const fake = makeFakeDb();
    const { runJob } = jobWithStatus('SUCCEEDED');
    const first = await receiver.receiveHandoff(validEnvelope(), options(fake, runJob));
    assert.equal(first.ok && first.handoff, 'ACCEPTED');

    const conflict = await receiver.receiveHandoff(
      validEnvelope({ description: 'A different proposal body entirely.' }),
      options(fake, runJob),
    );

    assert.equal(conflict.ok, false);
    assert.equal(!conflict.ok && conflict.status, 409);
    assert.equal(!conflict.ok && conflict.handoff, 'CONFLICT');
    assert.ok(fake.events.some((e) => e.kind === 'HANDOFF_CONFLICT'));
  });

  it('leaves the original delivery untouched when a conflict is refused', async () => {
    const fake = makeFakeDb();
    const { calls, runJob } = jobWithStatus('SUCCEEDED');
    await receiver.receiveHandoff(validEnvelope(), options(fake, runJob));
    const before = JSON.stringify(fake.rows.get('idem-1'));

    await receiver.receiveHandoff(
      validEnvelope({ title: 'A different proposal' }),
      options(fake, runJob),
    );

    const after = JSON.stringify(fake.rows.get('idem-1'));
    assert.equal(after, before, 'a conflicting delivery must not modify the stored row');
    assert.equal(calls.length, 1);
  });

  it('treats a changed correlation id as different content', async () => {
    const fake = makeFakeDb();
    const { calls, runJob } = jobWithStatus('SUCCEEDED');
    await receiver.receiveHandoff(validEnvelope(), options(fake, runJob));

    // The Job Runner's own idempotency key is <jobType>:<correlationId>, so a
    // different correlation id under the same key is a different execution.
    const conflict = await receiver.receiveHandoff(
      validEnvelope({ correlationId: 'corr-2' }),
      options(fake, runJob),
    );
    assert.equal(conflict.ok, false);
    assert.equal(!conflict.ok && conflict.handoff, 'CONFLICT');
    assert.equal(calls.length, 1);
  });

  it('does not treat a changed sender claim as different content', async () => {
    const fake = makeFakeDb();
    const { calls, runJob } = jobWithStatus('SUCCEEDED');
    await receiver.receiveHandoff(validEnvelope(), options(fake, runJob));

    // assertedEligibility is the sender's CLAIM. The receiver recomputes the
    // effective verdict server-side, so a re-assertion must not read as a
    // conflict — the content did not change.
    const replay = await receiver.receiveHandoff(
      validEnvelope({ assertedEligibility: 'REVIEW_REQUIRED' }),
      options(fake, runJob),
    );
    assert.equal(replay.ok, true);
    assert.equal(replay.ok && replay.handoff, 'DUPLICATE');
    assert.equal(calls.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Lost response / duplicate reconciliation
// ---------------------------------------------------------------------------
describe('PHASE 4 receiver contract — reconciliation after a lost response', () => {
  it('reconciles a duplicate attempt without a second execution', async () => {
    const fake = makeFakeDb();
    const { calls, runJob } = jobWithStatus('SUCCEEDED');

    // The producer's request reached the receiver and was committed, but the
    // response was lost in transit. The producer retries.
    await receiver.receiveHandoff(validEnvelope(), options(fake, runJob));
    const retries = [];
    for (let i = 0; i < 3; i += 1) {
      retries.push(await receiver.receiveHandoff(validEnvelope(), options(fake, runJob)));
    }

    assert.equal(calls.length, 1, 'reconciliation must never re-execute the work');
    for (const r of retries) {
      assert.equal(r.ok, true);
      assert.equal(r.ok && r.handoff, 'DUPLICATE');
      assert.equal(r.ok && r.duplicate, true);
    }
  });

  it('does not acknowledge a delivery whose dispatch outcome was never recorded', async () => {
    const fake = makeFakeDb();
    const { runJob } = jobWithStatus('SUCCEEDED');
    await receiver.receiveHandoff(validEnvelope(), options(fake, runJob));

    // Simulate the crash window: the row says ACCEPTED but the JobRun pointer
    // was never written. The outcome is ambiguous, so it must not be reported
    // as a clean duplicate.
    const row = fake.rows.get('idem-1') as Record<string, unknown>;
    row.jobRunId = null;

    const replay = await receiver.receiveHandoff(validEnvelope(), options(fake, runJob));
    assert.equal(replay.ok, true);
    assert.equal(replay.ok && replay.handoff, 'DEGRADED');
    assert.equal(replay.ok && replay.duplicate, false);
  });
});

// ---------------------------------------------------------------------------
// Verdict preservation — never acknowledge a failure as success
// ---------------------------------------------------------------------------
describe('PHASE 4 receiver contract — verdict preservation', () => {
  const cases: { status: JobStatus; handoff: string; http: number }[] = [
    { status: 'FAILED', handoff: 'FAILED', http: 502 },
    { status: 'BLOCKED', handoff: 'BLOCKED', http: 409 },
    { status: 'HUMAN_REVIEW', handoff: 'REVIEW_REQUIRED', http: 409 },
    { status: 'DEGRADED', handoff: 'DEGRADED', http: 202 },
  ];

  /** Read the verdict fields regardless of which branch of the union it is. */
  for (const c of cases) {
    it(`reports a ${c.status} job as ${c.handoff} and never as a success`, async () => {
      const fake = makeFakeDb();
      const { runJob } = jobWithStatus(c.status);
      const result = verdictOf(
        await receiver.receiveHandoff(validEnvelope(), options(fake, runJob)),
      );

      assert.equal(result.handoff, c.handoff);
      assert.equal(result.status, c.http);
      assert.notEqual(result.handoff, 'ACCEPTED');
      // The durable row carries the same verdict, so a replay reports it too.
      const row = fake.rows.get('idem-1') as Record<string, unknown>;
      assert.equal(row.status, c.handoff);
    });

    it(`never reports a stored ${c.status} record as successfully processed on replay`, async () => {
      const fake = makeFakeDb();
      const { runJob } = jobWithStatus(c.status);
      await receiver.receiveHandoff(validEnvelope(), options(fake, runJob));

      const replay = verdictOf(
        await receiver.receiveHandoff(validEnvelope(), options(fake, runJob)),
      );
      assert.notEqual(replay.handoff, 'DUPLICATE');
      assert.notEqual(replay.handoff, 'ACCEPTED');
      assert.equal(replay.handoff, c.handoff);
      assert.equal(replay.status, c.http);
    });
  }

  it('does not re-dispatch work for a stored FAILED record', async () => {
    const fake = makeFakeDb();
    const { calls, runJob } = jobWithStatus('FAILED');
    await receiver.receiveHandoff(validEnvelope(), options(fake, runJob));
    await receiver.receiveHandoff(validEnvelope(), options(fake, runJob));
    assert.equal(calls.length, 1, 'a replay must not re-execute a failed delivery');
  });
});

// ---------------------------------------------------------------------------
// Ambiguous persistence
// ---------------------------------------------------------------------------
describe('PHASE 4 receiver contract — ambiguous persistence', () => {
  it('reports an unknown commit outcome as an error, never as a success', async () => {
    const fake = makeFakeDb({ failCreate: true });
    const { calls, runJob } = jobWithStatus('SUCCEEDED');
    const result = await receiver.receiveHandoff(validEnvelope(), options(fake, runJob));

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.status, 502);
    assert.equal(calls.length, 0, 'nothing may be dispatched when the reservation failed');
    assert.ok(fake.events.some((e) => e.kind === 'HANDOFF_ERROR'));
  });

  it('never fabricates a duplicate when the row cannot be read back', async () => {
    // The reservation failed AND the row cannot be found: the receiver has no
    // evidence either way, so it must not answer "already processed".
    const fake = makeFakeDb({ failCreate: true, hideRows: true });
    const { runJob } = jobWithStatus('SUCCEEDED');
    const verdict = verdictOf(
      await receiver.receiveHandoff(validEnvelope(), options(fake, runJob)),
    );

    assert.equal(verdict.ok, false);
    assert.equal(verdict.status, 502);
    assert.equal(verdict.duplicate, false);
  });

  it('refuses a concurrent loser the same truth as the winner', async () => {
    const envelopeModule = await import('../handoff-envelope');
    const validated = envelopeModule.validateHandoffEnvelope(validEnvelope());
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const digest = envelopeModule.handoffContentDigest(validated.envelope);

    // The winner committed first; the loser's INSERT loses the unique-index
    // race. The loser must answer from the WINNER's durable row.
    const loser = makeFakeDb({ failCreate: true });
    loser.rows.set('idem-1', {
      id: 'handoff-1',
      idempotencyKey: 'idem-1',
      status: 'ACCEPTED',
      correlationId: 'corr-1',
      contractId: 'contract-abc-1',
      eventType: 'OPPORTUNITY_PROPOSED',
      title: validEnvelope().title,
      payloadJson: JSON.stringify({ v: 1, contentDigest: digest, payload: { notes: 'plain data only' } }),
      jobRunId: 'job-run-1',
      opportunityId: 'opp-1',
      halalStatus: 'HALAL',
      eligibility: 'ALLOWED',
      reason: 'Accepted and dispatched to the Job Runner.',
    });

    const { calls, runJob } = jobWithStatus('SUCCEEDED');
    const result = await receiver.receiveHandoff(validEnvelope(), options(loser, runJob));

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.handoff, 'DUPLICATE');
    assert.equal(calls.length, 0, 'the loser must not dispatch a second job');
  });
});

// ---------------------------------------------------------------------------
// HTTP boundary — bounded retries
// ---------------------------------------------------------------------------
describe('PHASE 4 receiver contract — HTTP boundary', () => {
  it('answers 429 with a Retry-After a producer can honour', async () => {
    const { enforceRateLimit } = await import('@/lib/security/guard');
    const identity = `contract-identity-${Date.now()}`;
    let refused: { allowed: boolean; retryAfterSeconds?: number } | null = null;
    for (let i = 0; i < 4; i += 1) {
      const verdict = await enforceRateLimit({
        surface: 'api:handoff:receive:contract-test',
        identity,
        max: 2,
        windowSeconds: 60,
      });
      if (!verdict.allowed) refused = verdict;
    }
    assert.ok(refused, 'the limiter must refuse once the window budget is spent');
    assert.ok(
      !refused.allowed && typeof refused.retryAfterSeconds === 'number' && refused.retryAfterSeconds > 0,
      'a refusal must carry a positive, bounded Retry-After',
    );
    assert.ok(!refused.allowed && refused.retryAfterSeconds! <= 60);
  });

  it('fails closed when no operator credential is configured', async () => {
    const { requireOperator } = await import('@/lib/security/guard');
    const previous = process.env.OPERATOR_CONTROL_TOKEN;
    delete process.env.OPERATOR_CONTROL_TOKEN;
    delete process.env.OPERATOR_REVENUE_TOKEN;
    try {
      const request = new Request('https://example.test/api/handoff/receive', {
        method: 'POST',
        headers: { authorization: 'Bearer anything' },
      });
      const auth = await requireOperator(request, 'api:handoff:receive:contract-test');
      assert.equal(auth.ok, false);
      assert.equal(!auth.ok && auth.status, 503);
      assert.equal(!auth.ok && auth.configured, false);
    } finally {
      if (previous) process.env.OPERATOR_CONTROL_TOKEN = previous;
    }
  });
});
