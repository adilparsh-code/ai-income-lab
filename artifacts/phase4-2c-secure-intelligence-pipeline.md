# Phase 4.2C — Secure multi-tenant intelligence pipeline completion

Date: 2026-11-10
Repository: `adilparsh-code/ai-income-lab` (root), nested `AIAgent/` untouched.
Branch at start and end: `feat/handoff-receiver-finalization`, root HEAD `caceac2`.
No commit, no push, no deployment, no production migration.

---

## A. Executive summary

This phase closed the largest gap left by Phase 4.2B.1: the handoff receiver had **no
tenant authorization at all**. It recorded whatever sender identity the caller supplied
and accepted deliveries for any tenant, because the root application had no tenant or
membership model.

What was actually implemented:

1. **Authoritative tenancy** — new `Tenant` and `TenantMembership` models, a nullable
   `tenantId` on `Opportunity` and `OpportunityHandoff`, a nullable `payloadHash` on
   `OpportunityHandoff`, and an additive migration (`0014`). Membership is resolved
   server-side from the authenticated credential **fingerprint**; the request can only
   name a tenant it already belongs to.
2. **A fail-closed authorization gate** (`src/lib/integrations/tenant-authorization.ts`)
   that refuses missing principals, unknown principals, suspended memberships, inactive
   tenants, ambiguous targets, disallowed roles and an unreachable authorization backend.
   Every decision is audited. There is no default tenant.
3. **Receiver integration** — authorization runs *before* idempotency (so a foreign caller
   cannot probe keys), accepted deliveries are bound to the authorized tenant, and intake
   now creates a real tenant-bound `Opportunity` that the run is traceable to.
4. **Idempotency hardening** — a canonical body fingerprint means the same key with a
   changed body is a `409` conflict rather than a silent `DUPLICATE`, including on the
   concurrent-loser path; a key owned by another tenant is a `403`.
5. **Real pipeline orchestration** — `OPPORTUNITY_PROPOSED` now dispatches the **existing**
   bounded `OPPORTUNITY_PIPELINE` (RESEARCH → VALIDATION → PRODUCT concept) instead of
   stopping after research, and the human-review boundary is recorded as a PENDING
   `HumanReview` row when the pipeline asks for a decision.
6. Tests, typecheck, lint, full regression and production build are green and recorded in
   §H. Nothing was fabricated and nothing was marked PASS without being executed.

What was deliberately **not** done: no automatic publishing, pricing, payment, storefront
activation or product-spec creation; no production migration; no AIAgent changes; no
blanket tenant columns on every downstream table (see §K/§L).

---

## B. Architecture — reused vs introduced

Reused (no duplicates created):

| Concern | Existing component |
|---|---|
| Transport auth, rate limit, body bounds | `src/lib/security/guard.ts` (`requireOperator`, `enforceRateLimit`, `readJsonBody`) |
| Envelope contract + halal resolution | `src/lib/integrations/handoff-envelope.ts`, `src/lib/halal-filter.ts` |
| Job execution, idempotency, halal gates | `src/lib/jobs/job-runner.ts`, `job-definitions.ts`, `types.ts` |
| Research / validation / product agents | `src/lib/agents/*` via the agent registry, driven by the orchestrator |
| Multi-stage orchestration | `src/lib/ruflo/orchestrator.ts` `runPipeline` (existing bounded workflow) |
| Approvals | `src/lib/security/approvals-core.ts` (untouched) |
| Product Factory canonical identity / spec idempotency | `src/lib/product-factory/canonical.ts`, `product-generation.ts` (untouched) |

Introduced (only what did not exist):

- `src/lib/integrations/tenant-authorization.ts` — the authorization decision function and
  its narrow persistence seam.
- Prisma `Tenant`, `TenantMembership`; `Opportunity.tenantId`; `OpportunityHandoff.tenantId`
  and `payloadHash`.
- `prisma/migrations/0014_tenant_handoff_authorization/migration.sql` (additive, not applied).
- `scripts/grant-tenant-membership.mjs` — explicit, `CONFIRM=yes`-gated admin provisioning.
- `src/lib/integrations/__tests__/tenant-authorization.test.ts`.

---

## C. Tenant authorization

### C.1 Trust boundary (authoritative identity)

- The **only** authentication is the existing operator credential gate. It returns
  `credentialFingerprint(token)` — an HMAC-SHA256 fingerprint truncated to 16 hex chars,
  never the credential.
- That fingerprint is the sender identity. A body field cannot assert it:
  `senderIdentity` is not an allowed envelope field and is rejected as an unknown field
  (asserted by tests).
- The tenant target comes from the `x-tenant-id` header. It is an **address, not a grant**:
  it is validated against `TenantMembership` rows for that fingerprint.

### C.2 Decision logic (fail-closed)

| Condition | Result |
|---|---|
| No principal | `403 MISSING_PRINCIPAL` |
| Authorization store throws | `503 AUTHORIZATION_UNAVAILABLE` (never grants) |
| No ACTIVE membership | `403 NO_MEMBERSHIP` |
| Several memberships, no tenant named | `409 TENANT_NOT_REQUESTED` (never "pick the first") |
| Named tenant not among memberships | `403 TENANT_NOT_AUTHORIZED` (also used for "tenant does not exist", so tenants cannot be probed) |
| Membership not ACTIVE | `403 MEMBERSHIP_SUSPENDED` |
| Tenant not ACTIVE | `403 TENANT_INACTIVE` |
| Role not `SENDER`/`ADMIN` | `403 ROLE_NOT_PERMITTED` |
| Otherwise | `ok`, `tenantId`, slug, role; audited `TENANT_AUTHORIZED` |

The receiver **auto-enforces** this whenever the database can resolve memberships
(`HandoffDb.tenantMembership` present). A caller cannot skip tenancy by omitting the injected
seam; injection only replaces *how* the decision is made, not *whether* it is made.

### C.3 Enforcement and binding evidence

- `OpportunityHandoff.tenantId` and the created `Opportunity.tenantId` both equal the
  authorized tenant (asserted in `tenant-authorization.test.ts` and in the real-DB receiver
  test).
- Unauthorized deliveries persist **no** handoff row, create **no** opportunity and dispatch
  **zero** jobs (asserted).
- Audit detail contains only tenant slug + role; it never contains the principal fingerprint
  or credentials (asserted).

---

## D. Handoff contract

| Property | Behaviour |
|---|---|
| Authentication | Operator credential (Bearer). No credential configured → `503`; bad → `401`. |
| Sender identity | Derived from the credential fingerprint; body value rejected. |
| Tenant binding | `x-tenant-id` validated server-side; bound on handoff + opportunity. |
| Envelope fields | Strict allow-list; unknown fields rejected (this is the lesson from 4.2B.1). |
| Event types | `OPPORTUNITY_PROPOSED` only. |
| Job type | Server constant `OPPORTUNITY_PIPELINE`; sender cannot influence it. |
| Stages | Server constant `['RESEARCH','VALIDATION','PRODUCT']`. |
| Idempotency | Same key + same body → `200 DUPLICATE`, no second job. Same key + changed body → `409` conflict (read path *and* create-race path). Same key, other tenant → `403`. |
| Correlation | Sender correlation id threaded through job, handoff row, audit and review record. |
| Bounds | Body ≤ 24 000 chars at the route; payload ≤ 16 KiB, depth ≤ 6, keys ≤ 50, fields ≤ 2000 chars. |
| Errors | Generic; no credentials, prompts, stack traces or raw payloads. |

---

## E. Intelligence execution

`OPPORTUNITY_PROPOSED` → `runJob('OPPORTUNITY_PIPELINE', { objective, opportunityId, stages: [RESEARCH, VALIDATION, PRODUCT] })`.

- **Stage A (intake):** envelope validated, halal screened server-side, `Opportunity` row
  created with `tenantId` and the recomputed `halalStatus`, handoff row linked to it.
- **Stage B (research):** executed by the existing research agent inside `runPipeline`;
  structured `ResearchResult` (findings, signals, assumptions, risks, competitors, demand
  indicators, monetization observations, evidence items, confidence, capability status).
  It does not invent statistics; mock-mode outputs are labelled `MOCKED`.
- **Stage C (validation):** executed by the existing validation agent; produces
  recommendation, confidence, tests and risks. Missing evidence does not become PASS —
  the mock path reports `opportunityExists:false`, and the pipeline's status aggregation
  promotes runs that demand review.
- **Stage D (product concept):** executed by the existing product agent; produces
  `productConcept`, MVP features, pricing hypothesis and monetization model. The stage list
  stops here — no experiment execution, publishing, pricing or spend.
- **Failure semantics:** a failed stage fails the run closed; downstream stages are skipped
  by the existing orchestrator, and the receiver marks the handoff `REJECTED` if dispatch
  throws.

Evidence that this is real orchestration, not a mock: `handoff-receiver.test.ts`'s real-DB
test calls the receiver with the **real** `runJob`, which runs the real pipeline against the
SQLite test database and persists a linked opportunity. The vertical slice additionally
asserts the full bundle shape offline (11/11).

---

## F. Halal and approval

- Halal status is recomputed by the receiver from `screenForHalalCompliance`; the sender's
  `assertedEligibility` is stored for audit only. `NOT_ALLOWED` → `409 BLOCKED` with no
  dispatch; `REVIEW_REQUIRED` → `409 REVIEW_REQUIRED` with no dispatch.
- The job runner re-screens the objective and honours `opportunity.halalStatus`
  (`NOT_ALLOWED` → `BLOCKED`, `REVIEW_REQUIRED` → `HUMAN_REVIEW`) before any agent call.
- The pipeline's own hard halal gate runs before any stage.
- **Human-review boundary:** when the pipeline reports `humanReviewRequired` (or the job
  status is `HUMAN_REVIEW`), the receiver writes a `PENDING` `HumanReview` row
  (category `SAFETY_REVIEW`) whose `evidenceRefs` point at the pipeline run, job run and
  correlation id. It approves nothing.
- Approval authority itself is unchanged: single-use, scoped, server-issued grants
  (`approvals-core.ts`), verified by the security suite. No cross-tenant approval binding was
  added (see §I/§K).

---

## G. Product Factory

- Reused, not duplicated: `ProductSpecification` canonical identity/hash and DB-level
  uniqueness live in `src/lib/product-factory/product-generation.ts` and `canonical.ts`.
- The handoff pipeline intentionally stops at a **product concept**, not a specification.
  Creating a `ProductSpecification` stays behind `PRODUCT_CREATE` plus an explicit approval
  token, which is the correct side of the human-review boundary.
- Existing factory idempotency (same concept → one spec; duplicate prevention) is covered by
  the product-factory suite inside the full green run (§H).

---

## H. Test report (exact commands and results)

All commands were run from the workspace root on 2026-11-10.

1. **Full root suite** (same globs as `npm test`):
   `npx tsx --test src/lib/ai/__tests__/*.test.ts src/lib/ruflo/__tests__/*.test.ts … src/lib/storefront/__tests__/*.test.ts --experimental-transform-options '{"esbuild":{"format":"esm"}}'`
   → **tests 1855, pass 1854, fail 0, skipped 1, cancelled 0, todo 0** (exit 0).
   The single skip is pre-existing: `live Ruflo V3 HTTP/MCP smoke test` (`# SKIP`, needs a live
   endpoint). It was not introduced or converted by this phase.
2. **Integrations folder** (all handoff/tenant/contract tests):
   → **tests 129, pass 129, fail 0, skipped 0**.
3. **Tenant authorization suite** (`tenant-authorization.test.ts`, real SQLite):
   → **15 tests, 15 pass**, covering: authorized bind, single-membership resolution, ADMIN
   role, missing principal, no membership, suspended membership, inactive tenant, bad role,
   spoofed tenant, ambiguous caller, backend failure (503), cross-tenant replay, identical
   replay vs changed-body conflict, concurrent conflict, body-asserted identity.
4. **Receiver suite** (`handoff-receiver.test.ts`): → **25 tests, 25 pass**, including the
   real-database persistence/dedup test that now executes the real pipeline and asserts the
   tenant-bound opportunity.
5. **Vertical slice** (`intelligence-vertical-slice.test.ts`): → **11 tests, 11 pass**;
   asserts pipeline dispatch, server-fixed stages, research/validation/product bundle shape,
   deterministic re-run, halal block/review, duplicate handling, approval single-use.
6. **Contract compatibility** (`contract-compatibility.test.ts`, AIAgent golden fixture):
   → **7 tests, 7 pass**; the adapter envelope is accepted, the dispatched payload is the
   receiver-built pipeline payload, and changed-body replay is refused.
7. **Typecheck**: `npx tsc --noEmit` → **exit 0**, no diagnostics.
8. **Lint**: `npx eslint .` → **exit 0, 0 errors**; 3 pre-existing warnings, all in
   `artifacts/eslint-agg.mjs` (unused imports in a report helper, not source).
9. **Production build**: `npm run build` → **`✓ Compiled successfully`**, route table includes
   `ƒ /api/handoff/receive`.
10. **Prisma**: `npx prisma7 generate` and `node scripts/generate-test-schema.mjs`
    (project's own supported commands) regenerated the root and SQLite test clients. Root
    client only; AIAgent's Prisma 5 setup was not touched.

No failing assertion was deleted, no test converted to a skip, and no mocked database result
is reported as real database verification.

---

## I. Security report

Fixed in this phase:

1. **Unauthenticated multi-tenancy** — any valid operator credential previously acted for any
   tenant. Now every delivery requires an ACTIVE membership, and the tenant is bound.
2. **Fail-open seam** — a real-database caller could previously omit the authorization seam.
   Now authorization is automatic whenever memberships are resolvable.
3. **Idempotency body substitution** — the same key with a changed body used to return
   `DUPLICATE`. Now `409`, on both the read path and the create-race loser path.
4. **Cross-tenant replay/probing** — a foreign key now returns `403` and authorization runs
   before the idempotency lookup, so key existence cannot be probed across tenants.
5. **Default-tenant assignment** — removed by construction: ambiguity is a `409`, never a
   silent choice.

Reviewed and unchanged (no defect found in scope):

- No IDOR path added; the receiver performs no client-directed lookups by id.
- No privilege escalation: roles are read from the DB, never from the request.
- No secret exposure: audit detail is slug + role + stable reason codes; responses are generic.
- Payload bounds, forbidden injection keys and unknown-field rejection remain enforced.
- Approvals remain single-use and scoped; publishing/payment remain gated.

Residual risks (explicitly **not** fixed, see §K):

- **Tenant-scoped read APIs do not exist yet.** `Opportunity` and `OpportunityHandoff` carry
  `tenantId`, but no read endpoint filters by it. Until tenant-scoped reads are implemented,
  isolation is enforced at *write/intake* time only.
- Downstream records (jobs, pipeline runs, agent logs, products, approvals, audit) do not carry
  their own `tenantId`. They are traceable to a tenant via `Opportunity.tenantId` →
  `opportunityId`, but a direct query on those tables is not tenant-filtered.
- `ApprovalGrant` is scoped by action + subject id, not by tenant. A cross-tenant approval
  binding needs a product decision.
- Existing rows keep `tenantId = NULL` (deliberate: no invented backfill).

---

## J. Changed files

Modified:

| Path | Reason |
|---|---|
| `prisma/schema.prisma` | `Tenant`, `TenantMembership`; nullable `tenantId` on `Opportunity`/`OpportunityHandoff`; nullable `payloadHash` |
| `src/lib/integrations/handoff-receiver.ts` | authorization gate, tenant binding, opportunity creation, payload-hash idempotency, pipeline dispatch, human-review record, race/conflict handling |
| `src/lib/integrations/handoff-envelope.ts` | event→job mapping is now `OPPORTUNITY_PIPELINE`; exported bounded stage list |
| `src/lib/jobs/job-runner.ts` | workflow outcome surfaces `humanReviewRequired` and `opportunityId` |
| `src/app/api/handoff/receive/route.ts` | reads `x-tenant-id`, injects the authorization decision |
| `src/lib/integrations/__tests__/handoff-receiver.test.ts` | pipeline job type, tenant-bound real-DB assertions |
| `src/lib/integrations/__tests__/contract-compatibility.test.ts` | pipeline payload contract assertions |

Added:

| Path | Reason |
|---|---|
| `src/lib/integrations/tenant-authorization.ts` | authorization decision + audit |
| `src/lib/integrations/__tests__/tenant-authorization.test.ts` | positive/negative matrix |
| `prisma/migrations/0014_tenant_handoff_authorization/migration.sql` | additive migration (not applied) |
| `scripts/grant-tenant-membership.mjs` | explicit admin provisioning, `CONFIRM=yes` required |
| `artifacts/phase4-2c-secure-intelligence-pipeline.md` | this report |

Pre-existing, untouched by this phase: root `package.json`, `package-lock.json`,
`tsconfig.json` modifications; all prior artifacts/logs; the entire `AIAgent/` tree.

---

## K. Limitations (nothing here is claimed as verified)

1. **No live AI/provider call.** All agent runs are the existing deterministic `MOCKED` mode.
   Output shapes and orchestration are verified; model quality is not.
2. **Validation does not consume research artifacts.** The existing orchestrator builds the
   validation request from the objective, not from the research result. Stage C is therefore
   *ordered after* research and halal-gated, but not *derived from* it. This is a real product
   gap, not a test gap.
3. **No tenant-scoped reads / no propagation to all downstream tables** (see §I residual risks).
4. **No production migration was run.** Migration `0014` is authored and unapplied; its
   rollback is documented in the file.
5. **No browser/UI verification.** This phase touched no UI.
6. **AIAgent not exercised.** No `AIAgent/node_modules` exists in this environment, so its
   Prisma 5 app cannot be run here; its 18 pre-existing modified test files were left untouched.
7. **Tenant membership must be provisioned explicitly** (`scripts/grant-tenant-membership.mjs`)
   before any handoff succeeds in a deployed environment. That is intentional fail-closed
   behaviour, but it is an operational step that has not been performed.
8. **One pre-existing skipped test** (live Ruflo smoke) remains skipped.

---

## L. Readiness matrix

| Capability | Status |
|---|---|
| Sender identity authenticated and trusted | IMPLEMENTED AND VERIFIED |
| Tenant membership resolved server-side | IMPLEMENTED AND VERIFIED |
| Unauthorized cross-tenant access rejected | IMPLEMENTED AND VERIFIED |
| Cross-tenant replay / key probing refused | IMPLEMENTED AND VERIFIED |
| Opportunity handoff idempotent (same body) | IMPLEMENTED AND VERIFIED |
| Changed-body reuse of a key refused (incl. race) | IMPLEMENTED AND VERIFIED |
| Halal screening enforced server-side | IMPLEMENTED AND VERIFIED |
| Research executes through real orchestration | IMPLEMENTED AND VERIFIED |
| Validation executes through real orchestration | IMPLEMENTED AND VERIFIED |
| Product concept generated after validation | IMPLEMENTED AND VERIFIED (as a stage in the real pipeline) |
| Product concept derived **from research artifacts** | PARTIALLY IMPLEMENTED — ordered after research, not fed by it |
| Concept traceable to opportunity + tenant | IMPLEMENTED AND VERIFIED |
| Human review required before commercial execution | IMPLEMENTED AND VERIFIED (review record + no commercial actions) |
| Positive/negative security tests | IMPLEMENTED AND VERIFIED |
| Tenant isolation on downstream tables / reads | PARTIALLY IMPLEMENTED — anchored at Opportunity, not propagated |
| Approval bound to a tenant | NOT IMPLEMENTED — approval grants are action/subject scoped |
| ProductSpecification created from the concept | NOT IMPLEMENTED BY DESIGN — requires approval + `PRODUCT_CREATE` |
| Production migration applied | BLOCKED — no production migration permitted in this phase |
| AIAgent contract exercised live | BLOCKED — AIAgent cannot be installed/run in this environment |

---

## M. Next implementation tasks (only genuine remaining work)

1. Propagate `tenantId` (or an enforced `opportunityId → tenant` join) to `JobRun`,
   `PipelineRun`, `ProductSpecification` and `ApprovalGrant`, and add tenant-scoped reads.
2. Feed the research result into the validation request so validation evaluates the actual
   findings rather than the objective alone.
3. Bind approvals to a tenant and reject an approval consumed for a different tenant.
4. Apply migration `0014` in the target environment, then provision the first tenant
   membership with `scripts/grant-tenant-membership.mjs`.
5. Decide the tenant-aware backfill policy for pre-existing rows (currently `NULL`).

---

## N. GitHub checkpoint readiness

- Root branch: `feat/handoff-receiver-finalization`; HEAD `caceac2`.
- AIAgent: branch `main`, HEAD `35afb7ccecd4a28df66b8d5702b0882ec58591dd`; 18 pre-existing
  modified test files, none touched by this phase.
- Tracked modifications in scope for the checkpoint: the 7 files in §J (plus the pre-existing
  `package.json`, `package-lock.json`, `tsconfig.json`, which are **not** mine and should be
  reviewed before staging).
- Untracked files in scope: the 4 new files in §J, plus the earlier Phase 4.2B/4.2B.1 artifacts
  and the untracked slice test/data files from the previous phase.
- Remote: nothing pushed. No force push, no history rewrite, no deployment.
- Suggested commit boundary for the checkpoint: the tenancy/authorization/receiver/pipeline
  changes in §J plus the new tenant test, migration, admin script and this report; leave the
  pre-existing root config changes and unrelated untracked logs/artifacts out unless explicitly
  approved.

---

Stop point reached: implemented, tested, reported. Awaiting explicit approval for the GitHub
checkpoint.
