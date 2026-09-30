# Agent Integration Contract v1 — External AI Agent Boundary (Phase 1)

**AI Income Lab remains the system of record and the authority.** This document
specifies the versioned, secure boundary through which an external AI Agent can
interact with AI Income Lab. No repository merge, no second Job Runner, no
Prisma/database access for agents, no new runtime — an agent gets exactly the
surface below and nothing else.

Status: **implemented as an idle, fail-closed boundary.** With no
`AGENT_<NAME>_TOKEN` configured, every request is refused with `503
NOT_CONFIGURED`; configuring a credential instantly activates the surface with
no code change. Nothing executes unless the existing gates pass.

Source of truth:

| Concern | Module |
| --- | --- |
| Wire schema + bounds + error codes | `src/lib/agent-contract/contract.ts` |
| Capability catalog + grants | `src/lib/agent-contract/capabilities.ts` |
| Credential discovery + auth | `src/lib/agent-contract/credentials.ts` |
| Enforcement chain (the processor) | `src/lib/agent-contract/processor.ts` |
| Audit records | `src/lib/agent-contract/audit.ts` |
| Bounded reads + health derivation | `src/lib/agent-contract/reads.ts` |
| Routes | `src/app/api/agent/v1/**` |
| Durable audit table | `AgentActionRecord` (`prisma/schema.prisma`, migration `0006_agent_contract`) |
| Test-double client (NOT a runtime) | `src/lib/agent-contract/mock-agent.ts` |

---

## 1. Trust model

- An external agent is a **different process on a different machine and fully
  untrusted**. Everything it sends is DATA. There is no instruction field; the
  action executed is chosen by the server from the capability catalog, never by
  the caller.
- Identity and authorization are **always derived server-side** from the
  presented credential. The request schema has no `role`, `admin`,
  `permissions`, `userId`, or `session` fields at all (`.strict()` — unknown
  fields are rejected), and the same words are forbidden as payload keys.
- The presented token is never logged, stored, or echoed. Only a keyed HMAC
  fingerprint (`credentialFingerprint`, 16 chars) is retained for audit
  correlation.
- Payloads are bounded structural data: ≤16 KB serialized, depth ≤6, ≤50 keys,
  strings ≤2000 chars. Keys such as `sql`, `prompt`, `command`, `token`,
  `instructions` are a REJECTION, never a sanitisation.

## 2. Authentication (server-to-server)

Dedicated, additive credential mechanism (admin sessions, the operator token,
and the Ruflo runtime token are untouched):

```bash
AGENT_<NAME>_TOKEN=<bearer-secret>            # server-side only, rotatable
AGENT_<NAME>_ID=<agent-identity>              # non-secret identity bound to the token
AGENT_<NAME>_CAPABILITIES=<grant>             # comma-separated capability ids, or *
```

Rules:

- `<NAME>` is the binding label: `A–Z 0–9 _` only (e.g. `AGENT_RESEARCH_LAB_TOKEN`).
- A binding without a non-empty `_TOKEN` **or** `_ID` is ignored (fail-closed),
  never guessed.
- Comparison is constant-time across every configured binding; a match yields
  the SERVER-derived identity (`agentId`, `credentialLabel`, fingerprint,
  grant).
- No `AGENT_*_TOKEN` exists → `503 NOT_CONFIGURED` for every request.
- Unknown token → `401`, audited, and throttled by a durable per-credential
  limiter (120/min, surface `agent:v1:auth`).
- The body's `agentId` is advisory: a mismatch with the credential binding is a
  `401 UNAUTHORIZED`, keeping audit rows unambiguous.

### Credential rotation

Set a new value on the existing `AGENT_<NAME>_TOKEN`; the change takes effect
on the next request. No code, schema, or restart dance — old presentations
simply stop matching. Audit history keeps the per-binding fingerprint, so a
rotation is visible in `AgentActionRecord` without exposing material.

## 3. Capability catalog (the entire reachable surface)

Nine capabilities, each with exactly one write authority. Nothing outside this
catalog is reachable through the agent API.

| Capability | Authority | Job type (fixed by server) | Halal-screened |
| --- | --- | --- | --- |
| `READ_OPPORTUNITY` | READ | — | no |
| `READ_ANALYTICS` | READ | — | no |
| `READ_REVENUE` | READ | — | no |
| `WRITE_RESEARCH_EVIDENCE` | SAFE_WRITE | `RESEARCH` | yes |
| `RUN_VALIDATION` | SAFE_WRITE | `VALIDATION` | yes |
| `CREATE_EXPERIMENT` | BOUNDED_WRITE | `OPPORTUNITY_PIPELINE` | yes |
| `CREATE_PRODUCT_PLAN` | BOUNDED_WRITE | `OPPORTUNITY_PIPELINE` | yes |
| `REQUEST_PUBLISH` | HUMAN_APPROVAL | never executes | no |
| `REQUEST_CONFIG_CHANGE` | HUMAN_APPROVAL | never executes | no |

- **READ** — bounded projections only (see `reads.ts`). Revenue is aggregate
  only; individual payment rows are never exposed.
- **SAFE_WRITE / BOUNDED_WRITE** — dispatched through the **existing Job
  Runner**, which re-runs its own halal, budget, idempotency, and retry gates
  inside `runJob()`. The caller never names the job type; the mapping is fixed
  per capability. Every job payload is stamped `source: 'AGENT_V1'`.
- **HUMAN_APPROVAL** — creates a `HumanReview` row (`PUBLICATION` /
  `SECURITY_CHANGE` categories) via the existing agency runtime and returns
  `202 HUMAN_APPROVAL_REQUIRED`. No work is ever executed by the request.
- A grant of `*` means all catalog capabilities; unknown grant entries are
  dropped; an empty grant means every action is refused with `403`.

## 4. HTTP surface

All routes are `dynamic = 'force-dynamic'`, authenticated with the agent
credential, and audited.

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/agent/v1/actions` | POST | Submit an action (the single mutating endpoint). |
| `/api/agent/v1/capabilities` | GET | This credential's server-derived capability view. |
| `/api/agent/v1/health` | GET | Truthful health: `READY \| DEGRADED \| BLOCKED \| NOT_CONFIGURED \| NOT_CONNECTED`. |
| `/api/agent/v1/jobs/:id` | GET | Status of a job this agent created (ownership-checked). |

Health is derived from real facts only — credential configuration, `SELECT 1`
database reachability, and the operator's global pause (`AgencyControl.key =
'autonomy'` → `BLOCKED`). No state is manually flipped, and a runtime is never
claimed LIVE without real verification.

Job ownership on `/jobs/:id` is enforced by construction: dispatched
correlations are namespaced `agent:<agentId>:<correlationId>`, so a job from
anyone else (operator, Ruflo, handoff, another agent) is indistinguishable from
nonexistent — both return `404`. No existence oracle, no cross-agent
enumeration.

## 5. Request schema (v1)

```jsonc
{
  "contractVersion": "v1",          // literal; anything else rejected
  "agentId": "research-lab",        // must match the credential binding
  "agentVersion": "1.4.0",          // self-declared, audit-only
  "requestId": "req-2026-000001",   // UNIQUE idempotency key (caller-owned)
  "correlationId": "corr-2026-000001", // threaded through JobRun + audit
  "timestamp": "2026-09-30T12:00:00.000Z",
  "action": "WRITE_RESEARCH_EVIDENCE",
  "payload": { "researchObjective": "Evaluate demand for a TypeScript toolkit." }
}
```

- Strict: unknown top-level fields are rejected (`400 INVALID_REQUEST`).
- Bounds: payload ≤16 KB (`413 PAYLOAD_TOO_LARGE`), depth ≤6, ≤50 keys, field
  strings ≤2000 chars.
- Forbidden payload keys (case/punctuation-insensitive): `instructions`,
  `command`, `cmd`, `shell`, `exec`, `execute`, `jobtype`, `sql`, `query`,
  `script`, `prompt`, `systemprompt`, `system`, `apikey`, `token`, `password`,
  `secret`, `authorization`, `role`, `admin`, `permissions`, `userid`,
  `session`, `cookie`.
- Body transport caps: 24 KB / 12,000 chars via the shared `readJsonBody`
  guard; a plain non-JSON body is a `400`.

## 6. Response envelopes

Success (subset; the full shape is `agentResponseSchema`):

```jsonc
{
  "contractVersion": "v1",
  "requestId": "req-2026-000001",
  "correlationId": "corr-2026-000001",
  "accepted": true,
  "status": "ACCEPTED",             // ACCEPTED | DUPLICATE | HUMAN_APPROVAL_REQUIRED
  "jobId": "cuid-of-jobrun",        // null when no job (reads/reviews/duplicates)
  "reviewId": null,                  // set for human-approval outcomes
  "result": { "jobType": "RESEARCH", "executionMode": "MOCKED", "...": "..." },
  "timestamp": "2026-09-30T12:00:01.000Z"
}
```

Errors:

```jsonc
{
  "contractVersion": "v1",
  "requestId": null,
  "correlationId": null,
  "code": "SAFETY_BLOCKED",
  "message": "Blocked: the request did not pass halal screening.",
  "details": [],
  "timestamp": "2026-09-30T12:00:01.000Z"
}
```

Stable error codes: `UNAUTHORIZED`, `NOT_CONFIGURED`, `FORBIDDEN_CAPABILITY`,
`FORBIDDEN_RESOURCE`, `SAFETY_BLOCKED`, `HUMAN_APPROVAL_REQUIRED`,
`DUPLICATE_REQUEST`, `RATE_LIMITED`, `PAYLOAD_TOO_LARGE`, `INVALID_REQUEST`,
`NOT_FOUND`, `BUDGET_EXCEEDED`, `INTERNAL_ERROR`.

Honest status mapping from the Job Runner outcome: `SUCCEEDED`/`DEGRADED` →
`201 ACCEPTED`, `BLOCKED` → `409 SAFETY_BLOCKED`, `HUMAN_REVIEW` → `202
HUMAN_APPROVAL_REQUIRED`, `FAILED` → `500 INTERNAL_ERROR`. The `executionMode`
reported is the runner's own value (`MOCKED` stays `MOCKED`; the API never
upgrades a claim to LIVE).

## 7. Idempotency

`requestId` is UNIQUE on `AgentActionRecord` and IS the duplicate guard:

1. A replayed `requestId` reads the stored row and returns the stored response
   with `200 DUPLICATE` — no second job, no second review, no second revenue
   row.
2. The audit row is **reserved before dispatch**, so a crash between accept
   and execute can never lose the trail; the reservation path is race-safe on
   the unique key.
3. Job-level idempotency stays with the Job Runner: correlation is
   `agent:<agentId>:<correlationId>`, so agents cannot collide with each other
   or with operator-dispatched work sharing a correlation id.

## 8. Safety chain (each gate fails closed)

Order in `processAgentAction`:

1. **Idempotency** — replay → stored response.
2. **Authorization** — server-derived grant; miss → `403 FORBIDDEN_CAPABILITY`.
3. **Resource** — a referenced `opportunityId` must exist (`404`); a
   NOT_ALLOWED opportunity on file blocks (`409 SAFETY_BLOCKED`).
4. **Safety / halal** — payload free text is screened by the EXISTING
   deterministic gate (`screenForHalalCompliance`), locally re-derived; a
   caller can never assert its way past it. `NOT_ALLOWED` → `409`;
   `REVIEW_REQUIRED` → a `SAFETY_REVIEW` HumanReview row and `202`, no job.
5. **Rate** — durable per-credential limiter (`AGENT_RATE_LIMIT_PER_MINUTE`,
   default 30, max 300; surface `agent:v1:actions`) → `429`.
6. **Dispatch** — the EXISTING Job Runner only, with the fixed capability→job
   mapping and `source: 'AGENT_V1'`. Missing required objective → `400`, and
   nothing is dispatched.
7. **Audit** — `AgentActionRecord` (status, jobId/reviewId, bounded
   secret-free result snapshot) + `SecurityEvent` rows on every refusal.
8. **Response** — bounded envelope; messages ≤300 chars, never internals.

The Job Runner's internal gates run AGAIN inside `runJob()` — this boundary
adds a net in front of them; it never replaces them.

## 9. Audit

Every request leaves durable evidence:

- `AgentActionRecord` (new, additive): `requestId` (unique), `agentId`
  (server-verified), `agentVersion`, `action`, `correlationId`,
  `authorizationResult` (`ALLOWED | DENIED_CAPABILITY`), `safetyVerdict`
  (`HALAL | REVIEW_REQUIRED | NOT_ALLOWED | NOT_APPLICABLE`, always locally
  derived), `status` (`ACCEPTED | DUPLICATE | REJECTED | BLOCKED |
  HUMAN_APPROVAL_REQUIRED | FAILED`), `jobId?`, `reviewId?`, `resultJson`
  (bounded, redacted), `reason` (secret-scrubbed), `agentFingerprint` (16-char
  HMAC), timestamps, and indexes on `(agentId, createdAt)`, `correlationId`,
  `(status, createdAt)`.
- `SecurityEvent` rows (`surface = 'api:agent:v1'` and route-specific) for
  auth failures, floods, schema rejections, duplicates, and accepted actions.
- `audit.ts` redacts secret-shaped keys and scrubs Bearer-token-shaped strings
  before anything is persisted.

## 10. Configuration reference

| Variable | Purpose | Default when missing |
| --- | --- | --- |
| `AGENT_<NAME>_TOKEN` | Bearer secret for one agent binding. | Binding ignored; with none configured the API is `503 NOT_CONFIGURED`. |
| `AGENT_<NAME>_ID` | Non-secret identity bound to that token. Required. | Binding ignored. |
| `AGENT_<NAME>_CAPABILITIES` | Grant list (comma-separated ids or `*`). | Empty grant → every action refused with `403`. |
| `AGENT_RATE_LIMIT_PER_MINUTE` | Durable per-credential action cap (1–300). | 30 |
| `SECURITY_FINGERPRINT_SALT` | Salt for credential fingerprints (existing variable). | Stable default salt |

All of these are server-side only. No `NEXT_PUBLIC_` equivalent exists and none
ever should.

## 11. Local development

The boundary is exercised end-to-end by the hermetic suite
(`npm test` → `src/lib/agent-contract/__tests__/`), including a mock agent
flow against the real route handlers and a temporary SQLite database.

```bash
npx prisma7 generate      # main client (new AgentActionRecord model)
npm run pretest           # regenerate SQLite test schema + template DB
npm test                  # includes the agent-contract suites
```

Manual smoke test with curl (after configuring one binding in `.env.local`):

```bash
curl -s http://localhost:3000/api/agent/v1/health \
  -H "Authorization: Bearer $AGENT_MOCK_AGENT_TOKEN"

curl -s -X POST http://localhost:3000/api/agent/v1/actions \
  -H "Authorization: Bearer $AGENT_MOCK_AGENT_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"contractVersion":"v1","agentId":"mock-agent-runtime","agentVersion":"1.0.0","requestId":"req-1","correlationId":"corr-1","timestamp":"2026-09-30T12:00:00.000Z","action":"WRITE_RESEARCH_EVIDENCE","payload":{"researchObjective":"Evaluate demand for a TypeScript toolkit."}}'
```

Network endpoint variables for a future local runtime are conventional and
NON-SECRET (they name an address, never a credential):
`AI_AGENT_URL=http://localhost:4000` (external agent runtime) and
`RUFLO_URL=http://localhost:5000` (Ruflo/Web4 integration service). Neither is
read by the v1 boundary; they are reserved names so the eventual wiring needs
no schema change.

`src/lib/agent-contract/mock-agent.ts` is a **deterministic TEST DOUBLE**
(env binding `AGENT_MOCK_AGENT_*`) used by the tests to demonstrate the
required flow: authenticated read → safe write → unauthorized capability →
safety rejection → duplicate/idempotency → job creation → job status → audit.
It is explicitly not a real agent runtime and nothing claims otherwise.

## 12. Future production wiring (deliberately out of scope)

The boundary is versioned (`contractVersion: 'v1'`, stable error codes) so a
future hosted agent runtime can be pointed at a deployed AI Income Lab without
schema or semantic changes:

1. Configure real bindings (`AGENT_<NAME>_TOKEN/_ID/_CAPABILITIES`) in the
   deployment platform's environment (not in any committed file).
2. Point the runtime at `https://<host>/api/agent/v1` and implement the
   envelope in this document.
3. Optional: tighten grants per environment (e.g. READ-only for a staging
   agent) — grants are per binding, not global.
4. Rotate by replacing `AGENT_<NAME>_TOKEN`; monitor via
   `AgentActionRecord`/`SecurityEvent`.

Out of scope by design: any Ruflo/Web4 runtime integration, bidirectional
webhooks, agent-to-agent messaging, and any widening of the capability catalog.
Ruflo/Web4 remains a future, separate integration — the handoff receiver
(`docs/handoff-receiver-high1.md`) and this contract stay independent
boundaries. **AI Income Lab remains the system of record and the authority for
every capability listed here.**

## 13. Security checklist (v1)

- [x] No agent ever touches Prisma, SQL, the filesystem, or env directly; the
      only path to execution is the existing Job Runner through fixed mappings.
- [x] Identity, authorization, and safety verdicts are always locally derived;
      client-asserted values can never influence them.
- [x] Fail-closed when unconfigured (`503`), unknown (`401`), unauthorized
      (`403`), unsafe (`409`), or over rate (`429`).
- [x] Constant-time credential comparison; only HMAC fingerprints retained.
- [x] Secrets redacted from audit rows; Bearer-token-shaped strings scrubbed.
- [x] Idempotent by `requestId` (unique) and by Job Runner correlation.
- [x] Durable rate limiting shared across instances (no in-memory-only caps).
- [x] Human approval required for publication and configuration changes; a
      flagged payload holds for review with nothing executed.
