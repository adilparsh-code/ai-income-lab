# Phase 4.2D — Complete multi-tenant data isolation & authorization

Date: 2026-11-10
Repository: `adilparsh-code/ai-income-lab` (root only; `AIAgent/` untouched)
Branch: `feat/handoff-receiver-finalization`, HEAD `caceac2`
No commit, no push, no deployment, no production migration, no production access.

---

## 1. Executive summary

Phase 4.2C produced a real tenant boundary at **one** edge (the handoff receiver).
Everything downstream was still globally readable: jobs, pipeline runs, research,
product-factory records, reviews, approvals and audit had no tenant attribution at
all, and every read API returned the whole database.

Phase 4.2D turns that single gate into an application-wide partition:

- **Ownership is persisted** on the records that are actually queried directly
  (`JobRun`, `PipelineRun`, `ResearchResult`, `ProductSpecification`,
  `HumanReview`, `ApprovalGrant`, `SecurityEvent`), and **inherited through
  trusted relations** where a parent is authoritative (`Product` → `Opportunity`,
  `ProductGeneration/Version/Package` → `ProductSpecification`). No duplicated
  tenant columns where a parent is enough.
- **One authorization decision function** (`authorizeTenantAccess`) serves handoff,
  console reads, console writes and tenant administration. Surfaces differ only in
  the permission they require.
- **One scope module** (`src/lib/tenancy/scope.ts`) resolves the principal from an
  admin session or the operator credential and produces the only object that can
  drive a tenant-owned query.
- **A disjoint legacy partition** replaces the old "no tenant → see everything"
  behaviour: pre-tenancy rows (`tenantId = NULL`) are visible only to a principal
  with **zero** memberships, and tenant members never see them. Tenant rows are
  invisible in legacy mode. Neither side can cross.
- **Read APIs are enforced**: jobs (list + single), reviews (list/decide/create),
  approvals (issue, subject-verified), research artifacts (list + single), audit
  events, and a new tenant-context endpoint. Foreign resources answer `404`, never
  "forbidden", so ids cannot be probed.
- **Background execution** derives the tenant from the parent opportunity, refuses
  a mismatched caller-supplied tenant, drops the cross-tenant reference, persists
  the tenant on the job row, and preserves it across retries.
- **Research → validation provenance is real**: the pipeline now persists a
  `ResearchResult` and passes its id into VALIDATION, closing the 4.2C limitation.

Three defects were found by this work and fixed before the report:

1. A principal whose **only** membership was `SUSPENDED` would have fallen into the
   legacy partition (the membership query filtered `ACTIVE`, so "zero active" looked
   like "zero memberships"). Suspension now authorizes nothing.
2. A refused cross-tenant job kept `opportunityId` pointing at the foreign
   opportunity, leaking its existence through `/api/jobs`. The reference is now
   cleared.
3. Global canonical product identity would have silently handed tenant A's
   specification to tenant B when both submitted the same logical spec. That is
   now an explicit, typed conflict.

What is **not** done is stated in §18 and §19: server-action/page loaders outside
the routes listed above are not yet scope-threaded, the Postgres migration could
not be executed in this environment (no Postgres binaries), and the tenancy test
suite is not part of `npm test` because `package.json` was not modified without
approval.

---

## 2. Project instruction compliance

- Read `AGENTS.md` (Next.js agent rules) and `CLAUDE.md`; no architecture-review
  gate or write-gate applies beyond the existing repository conventions.
- Preserved all pre-existing modifications: root `package.json`,
  `package-lock.json`, `tsconfig.json`, `prisma/schema.test.prisma`, and the
  earlier 4.2B/4.2C source changes. No `git clean`, `reset`, `checkout` or
  destructive cleanup was run.
- Did not modify `AIAgent/` (still `main` @ `35afb7c`, 18 pre-existing modified
  test files untouched) and did not touch its Prisma 5 schema/client.
- Reused the existing guard, job runner, orchestrator, agency runtime, approval
  core, product factory and audit trail. No parallel authorization system, no
  second job runner, no in-memory production approval store.
- No dependency changes and no lockfile edits.

---

## 3. Initial repository baseline

- Root: branch `feat/handoff-receiver-finalization`, HEAD `caceac2`.
- Working tree already contained 4.2C changes (tenant models, authorization,
  pipeline dispatch, tests) plus the earlier root config modifications and many
  untracked logs/artifacts. All retained.
- Prisma 7 client present; `prisma/test-template.db` regenerated for tests.
- Phase 4.2C report reviewed; its stated limitations were the input to this phase.

---

## 4. Existing ownership graph (before this phase)

```
Tenant ──< TenantMembership
  └── Opportunity.tenantId (nullable, 4.2C)
        └── OpportunityHandoff.tenantId (nullable, 4.2C)
```

Everything else — `JobRun`, `PipelineRun`, `ResearchResult` (did not exist),
`ProductSpecification`/`Generation`/`Version`/`Package`, `HumanReview`,
`ApprovalGrant`, `SecurityEvent` — had **no tenant attribution**. Reads were
global. This is the gap the phase had to close, not a column to add blindly.

---

## 5. Changed schema and migrations

New migration: `prisma/migrations/0015_tenant_isolation_propagation/migration.sql`
(additive, nullable, **no automatic backfill**).

| Change | Purpose |
|---|---|
| `JobRun.tenantId` + `(tenantId, createdAt)` index | job is owned even without an opportunity |
| `PipelineRun.tenantId` + index, `(opportunityId)` index | run ownership + lifecycle lookups |
| `ResearchResult` table + `Opportunity` back-relation | persisted RESEARCH artifact (provenance) |
| `SecurityEvent.tenantId` + index | tenant-scoped audit visibility |
| `ProductSpecification.tenantId` + index | factory ownership; generation/version/package inherit |
| `HumanReview.tenantId` + index | review partition |
| `ApprovalGrant.tenantId` + index | approvals cannot cross tenants |

**Backfill policy:** none in the migration. Legacy rows stay `tenantId = NULL` and
are reachable only through the explicit legacy scope. Adopting them is a separate,
confirmed, audited operator action: `scripts/adopt-legacy-tenant.mjs`
(`CONFIRM=yes`, only `tenantId IS NULL`, refuses inactive tenants, `DRY_RUN=yes`
supported).

Migration↔schema structural check (scripted comparison): all six `tenantId`
columns and indexes appear in both schema and SQL; every `ResearchResult` scalar
field appears in the SQL (the only non-column name is the virtual `opportunity`
relation, as expected).

---

## 6. Tenant propagation matrix

| Entity | Ownership | Enforcement |
|---|---|---|
| `Tenant` / `TenantMembership` | authoritative | membership lookup only |
| `Opportunity` | direct `tenantId` | scoped reads, write guard, job parent check |
| `OpportunityHandoff` | direct (4.2C) | written by receiver; no read endpoint |
| `JobRun` | direct `tenantId` | inherited from opportunity, mismatch refused, persisted, retry-safe |
| `PipelineRun` | direct `tenantId` | persisted from run scope; mismatch fails the run |
| `ResearchResult` | direct `tenantId` | persisted with run scope + opportunity + job + correlation |
| Validation output | **inherited, not a table** | carries `researchResultId`; lives in `PipelineRun.result` |
| `ProductSpecification` | direct `tenantId` | scoped reads; global canonical identity cannot cross tenants |
| `ProductGeneration` / `ProductVersion` / `ProductPackage` | inherited via specification | relation-filtered reads |
| `Product` | inherited via `Opportunity` | relation-filtered reads + write guard |
| `Offer` | inherited via product → opportunity | approval scope resolution verifies it |
| `HumanReview` | direct `tenantId` | scoped list/decide/create; foreign decide = "not found" |
| `ApprovalGrant` | direct `tenantId` | issue/consume bound; atomic consume includes tenant |
| `SecurityEvent` | direct `tenantId` (nullable) | scoped audit endpoint + services |

---

## 7. Read API authorization inventory

| Surface | State |
|---|---|
| `GET /api/jobs` | **enforced** — `tenant:read`, scoped listing (`getRecentJobActivity(20, tenantId)`) |
| `POST /api/jobs` | **enforced** — `tenant:write`; job created with the resolved tenant, never a payload value |
| `GET /api/jobs/[id]` | **enforced** — scoped lookup; foreign id → `404` |
| `GET /api/tenant/context` | **new** — echoes the server-side decision (mode/tenant/role), `no-store` |
| `GET /api/research/results` | **new, enforced** — scoped list, foreign opportunity → empty |
| `GET /api/research/results/[id]` | **new, enforced** — foreign id → `404` |
| `GET /api/agency/reviews` | **enforced** — scoped list |
| `POST /api/agency/reviews` | **enforced** — create and decide both use the scope partition |
| `POST /api/approvals` | **enforced** — subject verified against the approver's tenant; grant minted in that tenant |
| `GET /api/research/status` | not tenant data (configuration posture only) |
| `GET /api/audit/events` | **new, enforced** — `tenant:admin`, scoped, bounded fields |
| Server actions / page loaders (opportunities, revenue, pipeline, growth, ops, clients, commercial, storefront) | **NOT yet scope-threaded** — see §18/§19 |
| Webhook `polar` surfaces | not tenant-scoped (provider-facing, signature-verified; no change) |

Dashboard: `getRecentJobActivity` now requires an owner partition and the page
passes the resolved scope (falling back to legacy on resolution failure), so the
activity list can no longer mix tenants.

---

## 8. Job isolation implementation

- `RunJobOptions.tenantId` is the **only** tenant input; the payload has no tenant
  field and the runner never reads one.
- Order of authority: the parent `Opportunity.tenantId` wins. If a tenant was also
  supplied and differs, the job is `FAILED` with
  "the authorized tenant does not match the opportunity owner", the agent executor
  is **not** called, and the row's `opportunityId` is cleared so no cross-tenant
  reference survives.
- If no tenant is supplied but the opportunity has one, that tenant is persisted
  (legacy callers cannot launder work into the legacy partition).
- `retryJob` forwards `options` (including `tenantId`) into `runJob`, so retries
  keep ownership.
- Job output/error text is unchanged and contains no foreign data.

---

## 9. Research / validation isolation and provenance

New `ResearchResult` row per research stage, written with
`tenantId`, `opportunityId`, `pipelineRunId` (when known), `jobId`,
`correlationId`, bounded `findings` JSON (≤20 000 chars), `provenance`,
`evidenceType`, `capabilityStatus` and `confidence`.

- `runPipeline` persists it immediately after a successful RESEARCH step.
- The VALIDATION request now carries `researchResultId` + a bounded
  `researchContext` summary (≤4 000 chars, framed as **untrusted data** in the
  prompt — "hypotheses, not verified facts").
- The validation result echoes `researchResultId`, so the run is traceable
  research → validation.
- If RESEARCH ran but the artifact could not be persisted, VALIDATION is **skipped**
  with a fail-closed note and the run is `PARTIAL`; it never validates an unbacked
  objective.
- Standalone VALIDATION (job-level, no RESEARCH stage) still works and claims no
  provenance.

Evidence: `src/lib/ruflo/__tests__/research-provenance.test.ts` (4/4) runs the real
pipeline and asserts the artifact row, its tenant/opportunity/job/correlation, the
validation output's `researchResultId`, the tenant-owned `PipelineRun`, the
mismatch refusal, and the no-fabrication case.

---

## 10. Product Factory isolation

- `getOrCreateSpecification(request, { tenantId })` writes the owning tenant.
- Because `canonicalHash` is globally unique (deliberate: it is the factory's
  idempotency key), a second tenant submitting the *identical* logical spec is
  refused with `SpecificationTenantConflictError` rather than being handed the
  first tenant's record. Same-tenant requests still deduplicate normally.
- Generation, version and package reads are relation-scoped
  (`generation.specification.tenantId`), so a guessed version/package id from
  another tenant resolves to `null`.
- No publishing, pricing or payment execution was added; the human-approval
  boundary is unchanged.

---

## 11. Approval and HumanReview isolation

- `ApprovalGrant.tenantId` is written on issue and included in the **atomic**
  consume condition, so a grant for tenant A cannot be spent by tenant B even in a
  race. Wrong tenant, wrong subject, wrong action and expiry all return a denial
  (`MISMATCH`/`EXPIRED`), and replay returns `CONSUMED`.
- `resolveApprovalScope(action, subjectId, authorizedTenantId)` resolves the
  subject's real owner (offer → product → opportunity; product → opportunity;
  deployment → product) and reports a foreign subject as "not found".
- `HumanReview` creation accepts the server-resolved tenant; `listHumanReviews`
  requires the partition (defaulting to legacy); `decideHumanReview` looks up and
  updates **with** the tenant condition, so a foreign decision returns
  "Review not found" and changes nothing.
- Approval authority itself is untouched: admin-session-only minting, single-use,
  session-liveness re-check at consume.

---

## 12. Audit visibility isolation

- `SecurityEvent.tenantId` is written only after a scope was authorized
  (`auditSecurityEvent({ ..., tenantId })`), never from request input.
- `listScopedSecurityEvents` applies the partition: tenant events for a tenant,
  global/legacy events for the legacy scope, and nothing else.
- `GET /api/audit/events` requires an admin session **and** `tenant:admin`
  permission, returns bounded fields only (`kind`, `outcome`, `surface`, `detail`,
  `tenantId`, `createdAt`) and is `no-store`.
- Existing handoff audit kinds/details were not renamed or weakened.

---

## 13. Cross-tenant security test results

`src/lib/tenancy/__tests__/tenant-isolation.test.ts` — **26 tests, 26 pass**, real
SQLite database, real scope resolution, real job runner, real Prisma approval store.

| Group | Covered |
|---|---|
| A. Cross-tenant reads (8) | opportunity, job, research, spec/generation/version/package, product, review, approval grant, audit (incl. legacy/tenant disjointness) |
| B. Cross-tenant writes (4) | foreign parent guard, review decision, specification ownership, approval subject scope |
| C. Approvals (3) | wrong tenant, wrong action/subject/expiry, correct-then-replayed grant |
| D. Background execution (4) | tenant persisted, mismatch refused + no execution + reference cleared, parent-derived tenant, retry preserves tenant |
| E. Scope resolution (7) | legacy partition, spoofed tenant, ambiguous membership (409), suspended-only membership, inactive tenant, read-only role write denial, authorization backend 503 |

Test seam discipline: only `executeAgentJob` is stubbed (it makes no authorization
decision). No authorization result is hardcoded to `true`, and no database path is
faked where the phase claims a database guarantee.

---

## 14. Migration verification

| Check | Result |
|---|---|
| `npx prisma7 validate` | schema valid |
| `npx prisma7 generate` | client generated with the new fields |
| Test schema + template regeneration | OK (`generate-test-schema.mjs`, `prepare-test-database.mjs`) |
| Structural SQL↔schema comparison | consistent for all new columns/indexes and the new table |
| Applying `0015` to a real PostgreSQL | **BLOCKED** — this environment has no `psql`/`postgres`/`pg_ctl`/`initdb` binaries (`NO_POSTGRES_BINARIES`), and no production DB access is permitted |
| Production migration | not run (prohibited) |

Consequence: the migration is authored, reviewed and structurally verified, but
**Postgres execution is unverified**. It must be exercised in a disposable
Postgres (shadow DB or CI service) before any deployment. This report does not
claim migration readiness.

---

## 15. Full regression results

| Command | Result |
|---|---|
| `npm test` (project script, pre-test regenerates the DB) | **1863 tests, 1862 pass, 0 fail, 1 skipped**, exit 0 |
| `npx tsx --test src/lib/tenancy/__tests__/*.test.ts …` (not in the npm globs) | **26 / 26 pass** |
| Domain subset (integrations, jobs, security, agency, product-factory, ruflo, agents) | **1008 tests, 1007 pass, 0 fail, 1 skipped** |
| `npx tsc --noEmit` | exit 0 |
| `npx eslint` (all files changed in this phase) | 0 errors, 0 warnings |
| `npm run build` | `✓ Compiled successfully`; route table includes `/api/tenant/context`, `/api/audit/events`, `/api/research/results`, `/api/research/results/[id]`, `/api/jobs`, `/api/jobs/[id]` |

The single skip is the pre-existing live Ruflo HTTP/MCP smoke test; it was not
introduced or converted by this phase. No assertion was deleted or weakened.

**Known coverage gap:** `package.json`'s `test` script globs do not include
`src/lib/tenancy/__tests__`. Modifying `package.json` requires approval, so the 26
isolation tests were run explicitly and are reported separately. The one-line fix
is to add `src/lib/tenancy/__tests__/*.test.ts` to the `test` script.

---

## 16. Security findings

Fixed during this phase:

1. **Suspension fell through to legacy access.** A principal with only a
   `SUSPENDED` membership produced "zero active memberships", which the new scope
   resolver interpreted as the legacy operator. Fixed by counting all memberships
   and refusing when none are active.
2. **Cross-tenant reference survived a refused job.** The failed `JobRun` kept
   `opportunityId` of the foreign opportunity, exposing its existence. Cleared.
3. **Global canonical product identity leaked across tenants.** Identical specs
   would resolve to the first tenant's row. Now an explicit typed conflict.
4. **Read APIs were entirely unscoped** (the phase's main defect class). Enforced
   on jobs, reviews, approvals, research, audit and tenant context, plus the
   dashboard activity list.
5. **Approvals were tenant-blind.** Grants now carry and enforce the tenant in the
   atomic consume condition.

Reviewed, no defect found in scope: no `tenantId` is ever read from a request body;
no `ownerId` is trusted; foreign ids return `404` not `403`; list/count queries on
the enforced surfaces are partition-filtered; refusal audits carry no principal or
credentials; the legacy partition cannot be entered by a member.

Residual risks are listed in §18.

---

## 17. Files changed and reasons

Modified:

| Path | Reason |
|---|---|
| `prisma/schema.prisma` | tenant columns, indexes, `ResearchResult`, `Opportunity` back-relation |
| `src/lib/integrations/tenant-authorization.ts` | permission-aware shared core (`tenant:read/write/admin`, `handoff:submit`) |
| `src/lib/jobs/job-runner.ts` | tenant option, parent-authority check, persistence, retry, pipeline context |
| `src/lib/jobs/job-registry.ts` | activity listing requires an owner partition |
| `src/lib/ruflo/orchestrator.ts` | `tenantId`/`jobId`/`correlationId`, `ResearchResult` persistence, validation provenance, tenant mismatch refusal |
| `src/lib/agents/types.ts`, `src/lib/agents/validation-agent.ts`, `src/lib/ai/agent-prompts.ts` | validation accepts and consumes research provenance (untrusted-framed) |
| `src/lib/product-factory/product-generation.ts` | specification ownership + cross-tenant conflict |
| `src/lib/security/approvals-core.ts`, `src/lib/security/approval-scope.ts`, `src/lib/security/guard.ts` | tenant-bound grants, subject ownership, tenant-aware audit |
| `src/lib/agency/runtime.ts` | tenant-scoped review create/list/decide |
| `src/lib/integrations/handoff-receiver.ts`, `src/app/api/handoff/receive/route.ts` | dispatch with the authorized tenant; review row tenant |
| `src/app/api/jobs/route.ts`, `src/app/api/jobs/[id]/route.ts` | scoped list/create/detail |
| `src/app/api/agency/reviews/route.ts`, `src/app/api/approvals/route.ts` | scope resolution on write/read |
| `src/app/(admin)/page.tsx` | scoped dashboard activity |

Added:

| Path | Reason |
|---|---|
| `prisma/migrations/0015_tenant_isolation_propagation/migration.sql` | additive migration |
| `src/lib/tenancy/scope.ts` | the single scope/partition authority |
| `src/lib/tenancy/scoped-reads.ts` | the only tenant-owned read/write helpers |
| `src/lib/tenancy/__tests__/tenant-isolation.test.ts` | 26-case isolation matrix |
| `src/lib/ruflo/__tests__/research-provenance.test.ts` | provenance verification |
| `src/app/api/tenant/context/route.ts` | authorized scope echo |
| `src/app/api/audit/events/route.ts` | scoped audit visibility |
| `src/app/api/research/results/route.ts`, `.../[id]/route.ts` | scoped research reads |
| `scripts/adopt-legacy-tenant.mjs` | explicit legacy adoption |
| `scripts/grant-tenant-membership.mjs` (updated) | `ADMIN_EMAIL` → `admin:<fp>` principal, `VIEWER` role |
| `artifacts/phase4-2d-complete-tenant-isolation.md` | this report |

Untouched: `AIAgent/` (entire tree), `package.json`, `package-lock.json`,
`tsconfig.json`, all unrelated untracked logs/artifacts.

---

## 18. Unresolved risks

1. **Server actions and page loaders are not scope-threaded** (opportunities,
   revenue, pipeline listing, growth, ops, clients, commercial, storefront,
   observatory). They still query globally. The read *API* surface is enforced;
   the *server-rendered* surface is not. This is the largest remaining gap and is
   the recommended next phase.
2. **Postgres migration execution is unverified** (§14).
3. **`AgentLog`, `WorkflowRun`, `FailureRecord`, `EvidenceItemModel`** remain
   unattributed; they are reachable only through a tenant-owned parent in new
   code, but no scoped helper covers direct reads.
4. **Validation results are not a first-class persisted row.** Provenance is the
   `researchResultId` on the validation output and the `ResearchResult` row;
   there is no `ValidationResult` table to scope independently.
5. **`Product` / `Offer` have no direct `tenantId`.** Isolation depends on the
   opportunity relation; a product with no opportunity is legacy-only.
6. **Tenant selection has no UI.** It is a header/cookie
   (`x-tenant-id` / `ail_tenant`); an admin with multiple memberships gets a `409`
   until the client names one, which is correct but not yet surfaced in the UI.
7. **The tenancy suite is outside `npm test`** until `package.json` is approved.
8. **Webhook surfaces (`/api/webhooks/polar*`)** are provider-facing and not
   tenant-scoped; they are signature-verified and out of this phase's scope.
9. **No live AI provider** was exercised (deterministic `MOCKED` mode only).

---

## 19. Readiness matrix

| # | Acceptance criterion | Status | Evidence |
|---|---|---|---|
| 1 | Tenant identity resolved server-side | **IMPLEMENTED AND VERIFIED** | `resolvePrincipal`/`resolveTenantScope`; 7 scope tests; no body/owner input |
| 2 | Opportunity ownership enforced | **IMPLEMENTED AND VERIFIED** | scoped reads + `requireScopedOpportunity`; tests A/B |
| 3 | Handoff ownership enforced | **IMPLEMENTED** (write path) | receiver binds tenant; no handoff read endpoint exists to scope |
| 4 | Job ownership enforced | **IMPLEMENTED AND VERIFIED** | runner + API + tests D |
| 5 | Research ownership enforced | **IMPLEMENTED AND VERIFIED** | `ResearchResult` + scoped reads/route + tests |
| 6 | Validation ownership enforced | **PARTIALLY IMPLEMENTED** | provenance id + tenant through `ResearchResult`/`PipelineRun`; no own table |
| 7 | Product ownership enforced | **IMPLEMENTED AND VERIFIED** | relation-scoped reads + approval subject check |
| 8 | Version/package access tenant-scoped | **IMPLEMENTED AND VERIFIED** | test A (foreign → `null`/`[]`) |
| 9 | Approval grants tenant-scoped | **IMPLEMENTED AND VERIFIED** | atomic consume includes tenant; tests C |
| 10 | HumanReview tenant-scoped | **IMPLEMENTED AND VERIFIED** | runtime + route; tests A/B |
| 11 | Read APIs enforce tenant auth | **PARTIALLY IMPLEMENTED** | jobs/reviews/approvals/research/audit enforced; other pages/actions not threaded |
| 12 | Updates/deletes enforce tenant auth | **PARTIALLY IMPLEMENTED** | review decide, approval consume, spec ownership; opportunity/product/offer mutations still unscoped |
| 13 | Background execution preserves tenant | **IMPLEMENTED AND VERIFIED** | tests D |
| 14 | Cross-tenant access denied | **IMPLEMENTED AND VERIFIED** | 26/26 isolation matrix |
| 15 | Research output consumed by validation | **IMPLEMENTED AND VERIFIED** | 4/4 provenance tests |
| 16 | Audit visibility respects boundaries | **IMPLEMENTED AND VERIFIED** (scoped surfaces) | `listScopedSecurityEvents` + `/api/audit/events`; agent-level events not yet tenant-tagged |
| 17 | Existing regression tests green | **IMPLEMENTED AND VERIFIED** | `npm test` 1863 / 1862 pass / 0 fail / 1 pre-existing skip |
| 18 | Migration documented and verified in isolation | **PARTIALLY IMPLEMENTED / BLOCKED** | authored + structural check + validate; Postgres execution **BLOCKED** (no binaries) |

---

## 20. Recommended next phase

1. **Thread the scope through every server action and page loader** (the same
   `resolveScopeForServerComponent` helper already exists), and add route-level
   tests that call the loaders with two tenants.
2. **Run `0015` against a disposable PostgreSQL**, then `prisma migrate status`
   and a drift check, before any deployment.
3. Persist validation as a first-class tenant-owned record, or explicitly record
   `researchResultId` on `PipelineRun.result` as the contract and test it.
4. Add `tenantId` to `AgentLog`/`WorkflowRun`/`FailureRecord` if direct scoped
   reads are ever needed (currently reachable only via parents).
5. Add the tenancy suite to the `npm test` globs (needs `package.json` approval).
6. Surface tenant context in the UI (selector + `409` handling) so a multi-tenant
   admin can name a tenant instead of hitting a refusal.

---

## 21. GitHub checkpoint readiness

- Root branch `feat/handoff-receiver-finalization`, HEAD `caceac2`; nothing
  committed, pushed, deployed or force-pushed. No history rewrite.
- Checkpoint candidate set: the 24 modified files in §17 **excluding** the
  pre-existing `package.json`, `package-lock.json`, `tsconfig.json`,
  `prisma/schema.test.prisma` (not authored by this phase), plus the 10 added
  files listed there.
- `AIAgent/` remains an independent tree at `main` @ `35afb7c` with its 18
  pre-existing modified test files; it must not be staged into this checkpoint
  and is not affected by these changes.
- Environment artifacts (`.qa-*`, `.slice-*`, `artifacts/eslint-agg.mjs`, etc.)
  are unrelated untracked files and should be excluded unless intentionally kept.

Stop point reached: implementation, verification and documentation complete for
the scope stated above. Awaiting approval for the GitHub checkpoint.
