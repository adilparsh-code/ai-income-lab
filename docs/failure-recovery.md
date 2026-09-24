# Failure Recovery

Status: **implemented and tested**.

Failures are classified as transient, permanent, configuration, authentication, provider unavailable, validation failure, business-rule rejection, human-review required, timeout, or unknown. Only transient/provider-unavailable/timeout failures can retry. Backoff is bounded (`30 * 2^attempt`, capped at one hour), retries are capped at five, and exhausted or unsafe failures enter dead-letter state.

`FailureRecovery` stores a bounded error summary, category, retry counts, symbolic resume point, state, dead-letter flag, and correlation ID. The authoritative Job Runner writes this ledger alongside `JobRun`, counts matching degraded attempts before retrying, and refuses retry when history cannot be read. It never stores credentials or raw provider payloads.

Authentication/configuration/validation/business-rule/human-review failures are not retried. Human review remains a terminal safe state until a human acts.

Implemented: `src/lib/operations/failure-recovery.ts`, `FailureRecovery` Prisma model, and primitive tests.
