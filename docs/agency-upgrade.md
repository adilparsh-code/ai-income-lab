# AGENTIC AI AGENCY UPGRADE — Architecture & Operations

Single-admin autonomous AI Income Agency layered ON TOP of the existing Next.js 16 + TypeScript + Prisma system. No CrewAI / Agency Swarm / multi-agent framework was introduced. The Job Runner (`src/lib/jobs/job-runner.ts` `runJob()`) remains the ONLY executor; the agency layer is governance, not a second execution path.

## 1. Single-admin auth (`/login`)

Env-driven; no signup path exists anywhere in the UI or API.

- `src/lib/agency/admin-auth.ts`: `verifyAdminCredentials`, DB-backed sessions (`AdminSession` — only an HMAC fingerprint of the presented token is stored), `ADMIN_SESSION_COOKIE='aill_admin_session'` (httpOnly, sameSite=lax), `LOGIN_RATE_LIMIT` = 10 attempts / 300 s (DB-backed), fail-closed 503 when credentials are not configured.
- Generate the hash with `node scripts/hash-admin-password.mjs --generate` (or pipe a password on stdin; minimum 12 chars). Output: `ADMIN_PASSWORD_HASH="scrypt:<saltHex>:<hashHex>"`.
- Required env: `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH` (preferred) or `ADMIN_PASSWORD` (fallback). Secrets live in the deployment environment — never in committed files.
- Session endpoints (`src/app/api/admin/session/route.ts`): `POST` login (rate-limited, audited), `DELETE` logout, `GET` status incl. `credentialStatus`.
- Page guard (`src/lib/agency/session-guard.ts`): `requireAdminPage(returnTo)` redirects unauthenticated page hits to `/login`; `requireAdminApi()` returns 401 for API routes. `safeReturnTo()` only accepts same-site relative paths.

## 2. Agent Contracts (typed)

`src/lib/agency/contracts.ts` defines `AGENT_CONTRACTS` for 13 agents (`AGENCY_AGENT_IDS` in `types.ts`): business-manager, research, validation, safety-halal, product, publishing, growth, revenue, analytics, memory, job-runner, supervisor, ruflo-adapter. Each contract is Zod-validated and declares stage, budget, timeout, retries, allowed tools, and communication permissions.

- `isToolForbiddenEverywhere` — hard-deny list for every agent (`db.raw-sql`, `shell.exec`, …).
- `isToolAllowedForAgent` / `isCommunicationAllowed` — directional allow-lists between agents.

## 3. Supervisor (pure logic)

`src/lib/agency/supervisor.ts` — no DB, fully unit-tested:

- `evaluateLoops(history)`: 8 detectors — identical jobs ≥5, identical failures ≥3, retry exhaustion, circular delegation, tokens >400k, cost >$10, safety rejections ≥3, stale >24 h.
- `evaluatePlan`: stage/budget/timeout/retry vs the agent's contract.
- `evaluateOutput`: rejects fabricated success (SUCCEEDED with `fallbackUsed`), safety-invalid outputs, negative cost.
- `supervisorVerdict`: precedence ESCALATE (safety) > QUARANTINE (loops) > PAUSE (plan/output) > PROCEED.

## 4. Health (honest, never fabricated)

`src/lib/agency/health.ts` — deterministic `evaluateAgentHealth`: paused → BLOCKED; no runs → UNKNOWN; running past timeout → DEGRADED; ≥3 consecutive failures → FAILED; safety rejection → BLOCKED; degraded-only → DEGRADED; else HEALTHY. **No agent is ever shown LIVE without real evidence.**

## 5. Durable runtime store

`src/lib/agency/runtime.ts` (Prisma-backed, all writes audited):

- `seedAgencyContracts()` — idempotent upserts of the 13 contracts + tool-permission ALLOW rows; called by the roster API.
- `recordAgentRun()` / `listAgentRuns()` — AgentRun rows with bounded lifecycle steps (`PLAN → VALIDATE_INPUT → SAFETY_CHECK → EXECUTE → VERIFY_OUTPUT → PERSIST_RESULT → UPDATE_MEMORY → REPORT`) and evidence refs.
- `sendAgentMessage()` / `listAgentMessages()` — communication allow-list enforced; refusals audited; payload capped at 8 000 chars.
- `refreshAgentHealth()` / `listAgentHealth()` — health upserts; honors `AgencyControl.paused`.
- `getAgencyControl()` / `setAgencyPaused()` — global pause with audit trail.
- `createHumanReview()` / `listHumanReviews()` / `decideHumanReview()` — decision categories validated against `HUMAN_REVIEW_CATEGORIES`; only PENDING reviews are decidable, exactly once.
- `agentRosterStatus()` — 13 entries with real statuses: BLOCKED / FAILED / DEGRADED / OFFLINE (no runs) / READY.

## 6. Supervised dispatch (the only agency execution path)

`src/lib/agency/supervised-dispatch.ts` `dispatchSupervised(input, options?)`:

1. Refuse unknown agents; refuse when `AgencyControl.paused` (HTTP 423); refuse agents with no JobType mapping (`AGENT_TO_JOB`: research, validation, product, analytics, business-manager only).
2. `evaluatePlan` fail → BLOCKED AgentRun + refusal carrying a `correlationId`.
3. Build a job-definitions-valid payload per type (PRODUCT uses `productType:'DIGITAL_PRODUCT'`; business-manager uses `decisionScope:'FULL_BUSINESS_REVIEW'`).
4. Call `runJob()` — the existing, unmodified executor. Halal gates, idempotency (`${jobType}:${correlationId}`), bounded retries all still apply.
5. Map results honestly: safetyVerdict BLOCKED→NOT_ALLOWED, HUMAN_REVIEW→REVIEW_REQUIRED; verification SUCCEEDED→PASSED, DEGRADED→FAILED, else NOT_APPLICABLE.
6. Record an AgentRun (lifecycle steps + `evidenceRefs:[{type:'JOB_RUN', id: jobId}]`), derive loop evidence from real run history, return `{ ok, agentRunId, jobId, jobStatus, verdict, verdictReasons, deduplicated, executionMode, correlationId }`.

## 7. Control center & APIs (admin-only)

- `/agents` — Agent Control Center (`src/components/agents/agent-control-center.tsx`): 13-agent roster with real status chips, global pause/resume, human-review queue with approve/reject, links to the 5 executable-agent detail pages. Unauthenticated visitors see the login gate (`admin-login-gate.tsx`).
- APIs (all behind `requireAdminApi()`):
  - `GET  /api/agency/roster` — auto-seeds, returns roster + health.
  - `POST /api/agency/dispatch` — supervised dispatch; PAUSED→423, REFUSED→409.
  - `GET|POST /api/agency/reviews` — list (`?status=`) / decide or create.
  - `GET|POST /api/agency/control` — read / set global pause.
- Sidebar entry: single **Agent Control** → `/agents`.

## 8. Behavior without admin env (fail-closed)

If `ADMIN_EMAIL` / credentials are unset, `adminCredentialStatus()` returns `NOT_CONFIGURED`: `/login` shows an honest banner, `POST /api/admin/session` returns 503, and every admin page/API stays locked. Nothing opens up "by default".

## 9. Tests

- `src/lib/agency/__tests__/agency-pure.test.ts` — contracts validity/uniqueness, forbidden tools, communication allow-list, supervisor plan/output/loops/verdict precedence, health states (UNKNOWN is never faked healthy).
- `src/lib/agency/__tests__/agency-runtime.test.ts` — hermetic SQLite (temp dir + `DATABASE_URL=file:…` + `prisma db push --schema prisma/schema.test.prisma`): seed idempotency, health round-trips, message bounds, review decide-once, pause→BLOCKED→resume, dispatch refusals, happy path via the `executeAgentJob` seam, honest FAILED run recording.

Run: `bun run test` (pretest regenerates the SQLite test schema).
