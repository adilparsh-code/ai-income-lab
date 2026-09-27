# Failure Recovery

Status: IMPLEMENTED / TESTED

Classifications:

`TRANSIENT PERMANENT CONFIGURATION AUTHENTICATION PROVIDER_UNAVAILABLE VALIDATION BUSINESS_RULE HUMAN_REVIEW TIMEOUT UNKNOWN`

## Policy

- Bounded retries (default 3, hard cap 5).
- Exponential backoff: `250 * 2^attempt` ms, capped at 8s.
- Retry count, last error, classification, recovery state, dead-letter flag, resume point are persisted on `FailureRecord`.
- Unclassified failures fail closed (`UNKNOWN`, non-retryable).

Never retried:

- authorization failures
- halal blocks (`BUSINESS_RULE`)
- human-review requirements
- permanent invalid input (`VALIDATION`)
- missing configuration

Exhausted retryable failures are dead-lettered. Nothing retries endlessly.

## Labels

| Path | Status |
|---|---|
| Classifier + backoff + plans | IMPLEMENTED / TESTED |
| Durable `FailureRecord` | IMPLEMENTED / TESTED |
| Live provider retry storms | NOT_CONNECTED (no live provider in default config) |
