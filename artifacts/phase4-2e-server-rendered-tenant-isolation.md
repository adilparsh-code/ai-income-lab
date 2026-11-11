# Phase 4.2E — Server actions, server-rendered pages & complete tenant access control

Date: 2026-11-11
Repository: `adilparsh-code/ai-income-lab` (root only; `AIAgent/` untouched)
Branch: `feat/handoff-receiver-finalization`, HEAD `caceac2`
No commit, no push, no deployment, no production migration.

---

## 1. Executive summary

Phase 4.2D closed the API/job/research/approval boundary but left the largest
hole open: **server actions and server-rendered loaders queried the whole
database**. Every dashboard number, opportunity list, revenue total and factory
summary was global, regardless of which tenant the signed-in admin belonged to.

Phase 4.2E closes that hole with one mechanism rather than a second framework:

- **`src/lib/tenancy/relation-scope.ts`** — the single translation from an
  authorized scope to a Prisma `where` fragment, including the models that have
  no tenant column and inherit ownership through Opportunity or
  Product → Opportunity. The tenant and legacy partitions are expressed once
  here, so no surface can invent its own rule.
- **`src/lib/tenancy/action-scope.ts`** — `currentScope(permission, surface)`
  resolves the scope from the real header store inside a Server Action or a
  render, using the *same* `resolveTenantScope` decision 4.2D established. It
  throws `TenantActionError` before any query runs, so a refusal never leaks a
  row.
- **Every business server action** now resolves a scope, filters its queries,
  verifies the parent on writes, and refuses to move ownership. `update` and
  `delete` use `updateMany`/`deleteMany` **with the tenant condition**, so a
  foreign id is "not found" and never mutated.
- **Page loaders** (dashboard stats, next best action, revenue chart, business
  intelligence, lifecycle, income engine, control center, operations, AI usage,
  product-factory summary) resolve the scope themselves. Pages did not need
  redesign: the boundary moved into the loader that already ran per request.
- **Aggregates are scoped**: counts, sums, group-bys and cost rollups are
  filtered at the database, not in memory after a global read.

The work also produced a measurement worth recording: this codebase has **no
tenant-sensitive cache** (`unstable_cache`/`revalidateTag` count: 0) and **no
export or download endpoint**, so there was no cache-key collision or signed-URL
leak to fix. That is documented rather than papered over with new
infrastructure.

What remains is stated plainly: the **Observatory** and **Commercial** composites
still read globally (they are large read-only aggregations over 20+ modules) and
the tenancy test suite is still outside `npm test` because `package.json` cannot
be changed without approval.

---

## 2. Instruction compliance

- Read `AGENTS.md`/`CLAUDE.md`; no architecture gate applies beyond existing rules.
- Read both prior reports (`phase4-2c-…`, `phase4-2d-…`) and resumed from their
  stated gaps rather than re-auditing.
- Reused `scope.ts`, `tenant-authorization.ts`, `scoped-reads.ts`,
  `requireAdminAction`, `requireAdminPageAccess`, the job runner, the
  orchestrator and the approval core. **No second authorization system.**
- No `package.json`/`package-lock.json` edits, no dependency upgrades, no
  `AIAgent/` changes, no destructive Git operations.
- All pre-existing modifications and untracked artifacts preserved (root config
  edits, 4.2B/4.2C/4.2D sources, logs, `AIAgent/`).

---

## 3. Initial Git baseline

- Branch `feat/handoff-receiver-finalization`, HEAD `caceac2`.
- Working tree already contained the 4.2C/4.2D changes (tenant schema, migration
  `0015`, scope module, scoped APIs, `ResearchResult`, 26-case isolation matrix)
  plus pre-existing config edits and untracked artifacts.
- `node_modules` was absent after a runner restart; restored with `npm ci`
  (lockfile unchanged), then `npx prisma7 generate`.
- Verified baseline before edits: `tsc` 0, `npm test` green, 0 cache tags.

---

## 4. Complete server-side surface inventory

Legend: **S** = scoped in this phase, **U** = still unscoped.

### 4.1 Server Actions (`'use server'`)

| File | Exported action | Op | Model(s) | Before | Now |
|---|---|---|---|---|---|
| `src/actions/opportunities.ts` | `getOpportunities` | read/list | Opportunity | admin only | **S** |
| | `getOpportunity` | read/detail | Opportunity + products/experiments/revenues | admin only | **S** |
| | `createOpportunity` | write | Opportunity | admin only | **S** (tenant assigned server-side) |
| | `updateOpportunity` | write | Opportunity | admin only | **S** (`updateMany` + tenant) |
| | `recordHalalReview` | write | Opportunity, HalalReview | admin only | **S** |
| | `deleteOpportunity` | delete | Opportunity | admin only | **S** (`deleteMany` + tenant) |
| `src/actions/revenue.ts` | `getRevenues`, `getRevenueSummary` | read/aggregate | Revenue | admin only | **S** |
| | `createRevenue`, `updateRevenue`, `deleteRevenue` | write | Revenue | admin only | **S** + attachment guard |
| `src/actions/experiments.ts` | `getExperiments`, `getExperiment` | read | Experiment | admin only | **S** |
| | `create/update/deleteExperiment` | write | Experiment | admin only | **S** + attachment guard |
| `src/actions/pipeline.ts` | `getPipelineOpportunities` | read | Opportunity | admin only | **S** |
| | `getRecentPipelineRuns` | read | PipelineRun | admin only | **S** |
| | `executePipelineRun` | write/execute | PipelineRun, agents | admin only | **S** (tenant from scope) |
| `src/actions/product-factory.ts` | `getFactoryOpportunities` | read | Opportunity | admin only | **S** |
| | `getRecentFactoryRuns` | read | PipelineRun | admin only | **S** |
| | `generateProductConcept` | write/execute | spec/generation | admin only | **S** |
| | `getFactoryRunDetail` | read/detail | PipelineRun | admin only | **S** (foreign id → not found) |
| | `getProductFactorySummary` | aggregate | Product, Build, Deployment, Asset, AgentLog | admin only | **S** |
| `src/actions/dashboard.ts` | 3 loaders | aggregate | see §5 | admin only | **S** (in loader) |
| `src/actions/lifecycle.ts` | `getLifecycleOverview` | aggregate | opp/exp/product/revenue/logs | admin only | **S** |
| `src/actions/business-intelligence.ts` | `getBusinessIntelligenceSummary` | aggregate | opp/exp/product/revenue | admin only | **S** |
| `src/actions/research.ts` | `getResearchEngineStatus` | config | none (no rows) | admin only | n/a — no tenant data |

### 4.2 Server components / loaders

| Surface | Model(s) | Status |
|---|---|---|
| `lib/loaders/dashboard.ts` (stats, next best action, revenue chart) | Opportunity, Product, Experiment, Revenue | **S** |
| `lib/loaders/business-intelligence.ts` | 4 models | **S** |
| `lib/loaders/lifecycle.ts` | 4 models + AgentLog attribution | **S** |
| `lib/income-engine/summary.ts` | Opportunity, Product, Revenue | **S** |
| `lib/agents/control-center.ts` | Opportunity | **S** |
| `lib/ops/dashboard.ts` (ops aggregates) | counts/sums over 7 models | **S** |
| `lib/product-factory/operations.ts` | JobRun, WorkflowRun, Product, Revenue, AgentLog | **S** |
| `lib/ai/usage-server.ts` (`getAiUsageForRange`) | AgentLog | **S** |
| `src/app/(admin)/ai-usage/page.tsx` | AgentLog | **S** (direct page query) |
| `src/app/(admin)/page.tsx` evidence counts + job activity | EvidenceItemModel, JobRun | **S** |
| `src/app/(admin)/observatory/page.tsx` → `lib/observatory/*` | 20+ models across 9 modules | **U** |
| `src/app/(admin)/operations/page.tsx` → ops view | see above | **S** (lib) |
| Commercial routes/pages (`/api/commercial/*`, `lib/commercial/*`) | Offer, Proposal, Engagement, Payment | **U** (write services are operator-token gated; reads unscoped) |
| `src/app/(storefront)/*` | Offer, Product | public by design (published storefront) |

### 4.3 Other server-side surfaces

| Category | Finding |
|---|---|
| Cache (`unstable_cache`, `cacheTag`, `revalidateTag`) | **none in the codebase** (grep count 0). Only `revalidatePath` is used, which does not store tenant data. |
| Exports / downloads / report generation | **none** (no `Content-Disposition`, `text/csv`, `application/zip`, blob downloads). |
| Bulk mutation endpoints | **none**; the actions are single-record, and per-record attachment guards apply. |
| Background surfaces | jobs/pipelines already tenant-bound in 4.2D (verified unchanged). |
| `raw SQL` | `$queryRaw` used only for `SELECT 1` health checks — no tenant data. |
| Mutation revalidation | `revalidatePath` only; no cross-tenant data is cached, so revalidation cannot expose a foreign row. |

---

## 5. Server Actions changed (what the guard actually does)

For every action above, the pattern is:

```ts
await requireAdminAction();                              // authentication (unchanged)
const scope = await currentScope('tenant:write', 'action:x'); // authorization
// every query carries the partition:
where: { id, ...opportunityWhere(scope) }
```

Mutation rules applied:

- **Create** — ownership is written from `scopeTenantId(scope)` *after* the
  client payload spread, so a smuggled `tenantId` cannot win. Child rows
  (`Revenue.opportunityId/productId`, `Experiment.opportunityId`) pass through
  `assertOpportunityInScope` / `assertProductInScope` first.
- **Update** — the row is first read inside the partition, then written with
  `updateMany({ where: { id, ...partition } })`; `count === 0` → "not found".
  Moving a row to a foreign parent is refused by the same attachment guards.
- **Delete** — `deleteMany({ where: { id, ...partition } })`; zero rows → "not found".
- **Approval / review** — unchanged from 4.2D (tenant-bound, single-use, expiry);
  the new surfaces only consume them.
- **Pipeline/factory execution** — the tenant is taken from the scope, never the
  payload; a foreign `opportunityId` is refused before the orchestrator runs.

---

## 6. Page loaders and layouts changed

No page markup or layout was redesigned. The scope moved into the data layer:

| Loader | Signature change | Behaviour |
|---|---|---|
| `getDashboardStats` | `(scope?)` | resolves `loader:dashboard` when omitted; 4 queries filtered |
| `getNextBestAction` | `(scope?)` | partition spread into the existing filter (status/halal/score preserved) |
| `getRevenueChartData` | `(scope?)` | revenue partition |
| `getBusinessIntelligenceSummary` | `(scope?)` | 4 queries filtered; fallback object unchanged |
| `getLifecycleOverview` | `(scope?)` | 4 queries filtered; AgentLog restricted to scoped ids |
| `getIncomeEngineSummary` | `(scope?)` | opportunity/product/revenue group-by filtered |
| `getControlCenterView` | `(scope?)` | opportunity selection filtered |
| `getPhase8OperationsView` | `(scope?)` | 7 aggregates filtered (see §7) |
| `getOperationsSummary` | `(scope?)` | 5 queries filtered |
| `getAiUsageForRange` | `(range, scope?)` | AgentLog restricted to scoped ids |

`src/app/(admin)/page.tsx` additionally resolves the scope itself for the two
direct `db.evidenceItemModel.count` calls and continues to pass the resolved
tenant to `getRecentJobActivity`.

Existing callers keep working: the parameter is optional and resolves from the
real request, so `src/actions/*` needed no signature churn.

---

## 7. Dashboard and aggregate isolation

Every aggregate now filters at the database:

| Aggregate | Before | Now |
|---|---|---|
| opportunity/experiment/product counts (ops) | `count()` | `count({ where: partition })` |
| lifetime revenue | `aggregate({ _sum })` | `aggregate({ where: revenuePartition })` |
| simulated revenue/profit | `simulationRun.aggregate` | filtered by scoped opportunity ids |
| loop transitions | `loopTransition.count()` | filtered by scoped opportunity ids |
| pending human review | `jobRun.count({status})` | `+ tenantId: scopeTenantId(scope)` |
| AI cost by product | `agentLog.groupBy` (global) | `AND: [agentLogPartition, productId not null]` |
| product factory AI cost | `agentLog.groupBy` (global) | scoped opportunity/product ids |
| AI usage page | global rows | `AND: [agentLogPartition, date range]` |
| evidence counts (dashboard) | global counts | `evidenceItemWhere(scope)` |
| income-engine group-by revenue | global | `where: revenueWhere(scope)` |

`AgentLog` has no tenant column and no relation, so its partition is derived
from the scoped opportunity/product ids (`agentLogWhere`). This is deliberate
and documented: unattributed logs belong to the legacy partition only.

No "global admin" bypass was introduced beyond the existing legacy partition
(principal with zero memberships). A tenant admin is never treated as global.

---

## 8. Cache isolation findings

- `grep -rn "unstable_cache|revalidateTag|cacheTag" src` → **0 matches**.
- The only cache interaction is `revalidatePath('/…')` in actions, which
  invalidates route caches and stores no data.
- `getAiUsageForRange` previously shared a request-level result via React
  `cache`? No — the file has no `cache()` wrapper; per-request memoization is
  Next's own and keyed by request.
- Conclusion: **no tenant-sensitive cache exists**, so no cache key exists that
  could collide across tenants. No cache infrastructure was added.

---

## 9. Export / download protection

- No export, CSV, ZIP, PDF, signed-URL or download route exists in the repo.
- The only outbound artifact path is `ProductAsset.origin` (a description), which
  is not served by this app.
- Therefore nothing to scope; the readiness matrix marks this **N/A (no
  surface)**, not "implemented".

---

## 10. Authorization contract

| Element | Definition |
|---|---|
| Principal | operator bearer → credential fingerprint; live admin session → `admin:<fingerprint(email)>` |
| Tenant selection | `x-tenant-id` header or `ail_tenant` cookie; **address, never a grant** |
| Decision | `authorizeTenantAccess` (permission-aware: `VIEWER: tenant:read`; `SENDER: +tenant:write, handoff:submit`; `ADMIN: +tenant:admin`) |
| Partitions | `tenant` → `tenantId = <tenant>`; `legacy` → `tenantId = NULL`; disjoint |
| Refusal | `TenantActionError` (`403`/`409`/`503`) thrown before queries; API surfaces map to 403/404 |
| Attachment | `assertOpportunityInScope` / `assertProductInScope` / `assertTenantAttachment` |
| Write ownership | derived from the scope only; client `tenantId` is deleted before update and overwritten on create |

Trust rules enforced: no body/query/FormData/hidden-field tenant id; no
client-supplied `ownerId`; no URL id used as authorization; a foreign id returns
"not found" rather than "forbidden" on reads.

---

## 11. Positive and negative test matrix

New file: `src/lib/tenancy/__tests__/server-surface-isolation.test.ts` — **16 tests**,
real SQLite database, real filters, real loader functions, no mocked decisions.

| Group | Tests |
|---|---|
| A. Relation partitions | opportunity direct column; product via opportunity (legacy keeps unattributed); revenue via opportunity **and** via product→opportunity; experiment; offer; AgentLog (tenant + legacy) |
| B. Aggregates | dashboard stats (A=1 opp/80 revenue, B=400, legacy=10); next-best-action never picks a foreign row; BI top entities never name the other tenant; lifecycle counts; income-engine counts |
| C. Write guards | foreign opportunity refused; foreign product refused; unattributed legacy parent refused from a tenant scope |
| D. Scope guard | valid membership resolves; **spoofed header refused (403)**; no principal refused (`NO_PRINCIPAL`); suspended membership refused (`MEMBERSHIP_SUSPENDED`); VIEWER cannot exercise `tenant:write` |

Positive/negative coverage required by the phase:

- Server actions: correct tenant succeeds (A), wrong tenant denied (D), missing
  auth denied (existing `requireAdminAction` tests), missing permission denied
  (VIEWER test), spoofed tenant ignored (D), wrong-owner resource denied (C).
- Page loaders: A sees own opportunity (B), B cannot see A (B), dashboard counts
  per tenant (B), direct navigation to foreign id → not found
  (`getOpportunity`/`getFactoryRunDetail` scoped `findFirst`), pagination/search
  inherit the partition because the filter is part of the same `where`.
- Approvals: unchanged 4.2D matrix (wrong tenant/action/expiry/replay) still green.
- Analytics: tenant-scoped counts and totals verified in B.
- Exports/cache: no surfaces exist; no meaningless tests were added.

---

## 12. Migration readiness

- `npx prisma7 validate` → valid.
- `npx prisma7 generate` → OK.
- Test schema/template regeneration (`generate-test-schema.mjs`,
  `prepare-test-database.mjs`) → OK.
- PostgreSQL execution of migration `0015` → **NOT VERIFIED / BLOCKED**:
  `which psql postgres initdb` → `NO_POSTGRES_BINARIES`. No production DB access
  is permitted, and PostgreSQL was not installed to force a result.
- 4.2E introduces **no schema change** and no new migration: all filtering is
  query-level. So there is no new migration risk in this phase; the existing
  `0015` risk from 4.2D is unchanged and still must be exercised in a disposable
  Postgres before deployment.

---

## 13. Exact test counts

| Command | Exit | Tests | Pass | Fail | Skip |
|---|---|---|---|---|---|
| `npm test` (project script; pretest regenerates DB) | 0 | 1863 | 1862 | 0 | 1 |
| `npx tsx --test src/lib/tenancy/__tests__/*.test.ts …` (not in npm globs) | 0 | **42** | 42 | 0 | 0 |
| targeted: `dashboard-schema-drift-db`, `phase8-e2e`, `operations` | 0 | 25 | 25 | 0 | 0 |
| `npx tsc --noEmit` | 0 | — | — | — | — |
| `npx eslint .` | 0 | — | 0 errors | 3 pre-existing warnings (`artifacts/eslint-agg.mjs`) | — |
| `npm run build` | 0 | compiled successfully | | | |

The single skip is the pre-existing live Ruflo HTTP/MCP smoke test.

**Test-discovery gap (still open):** `npm test` enumerates `src/lib/<domain>/__tests__`
explicitly and does **not** include `src/lib/tenancy/__tests__`. Adding it is a
one-line `package.json` change, which this phase is not allowed to make:

```diff
- "test": "tsx --test src/lib/ai/__tests__/*.test.ts …
+ "test": "tsx --test src/lib/tenancy/__tests__/*.test.ts src/lib/ai/__tests__/*.test.ts …
```

Until that is approved and applied, the 42 tenancy tests are reproducible only by
the explicit command above. This report does **not** claim `npm test` covers them.

---

## 14. Security findings and fixes

1. **Every business server action was globally readable/writable.** A tenant
   admin could list, edit and delete another tenant's opportunities, revenue and
   experiments (the actions only checked "is an admin"). Fixed with scope
   resolution + partitioned filters + `updateMany`/`deleteMany`.
2. **Dashboard and ops aggregates were global.** Counts, revenue sums and AI cost
   rollups mixed tenants. Fixed at the query level.
3. **AI usage/cost page aggregated all tenants' AgentLog rows.** Fixed with the
   derived AgentLog partition.
4. **Mass assignment was possible on opportunity create/update** (a runtime
   `tenantId` in the payload). Fixed: create overwrites ownership after the
   spread; update deletes the key defensively.
5. **Cross-tenant attachment on create** (revenue/experiment pointing at a
   foreign opportunity) was possible. Fixed with attachment guards; the
   "unattributed legacy parent" case is also refused.
6. **Foreign-run detail lookup** in the factory rehydrated any PipelineRun id.
   Fixed: a scoped existence check runs first and returns the existing safe
   "could not be found" error.
7. **Suspended/ambiguous/unauthorized principals** already failed closed in 4.2D
   and were re-verified against the new guard.

No assertion was weakened. Three pre-existing loader tests were updated to pass
an explicit legacy scope (they previously relied on the loader's implicit global
read) — their assertions are unchanged, and they now document the intended
partition for a no-tenant caller.

---

## 15. Exact changed-file list (this phase)

Modified:
- `src/actions/opportunities.ts`, `revenue.ts`, `experiments.ts`, `pipeline.ts`, `product-factory.ts`
- `src/lib/loaders/dashboard.ts`, `business-intelligence.ts`, `lifecycle.ts`
- `src/lib/income-engine/summary.ts`
- `src/lib/agents/control-center.ts`
- `src/lib/ops/dashboard.ts`
- `src/lib/product-factory/operations.ts`, `factory-service.ts`
- `src/lib/ai/usage-server.ts`
- `src/app/(admin)/page.tsx`, `src/app/(admin)/ai-usage/page.tsx`
- `src/lib/ops/__tests__/dashboard-schema-drift-db.test.ts`, `phase8-e2e.test.ts`
- `src/lib/product-factory/__tests__/operations.test.ts`

Added:
- `src/lib/tenancy/relation-scope.ts`
- `src/lib/tenancy/action-scope.ts`
- `src/lib/tenancy/__tests__/server-surface-isolation.test.ts`
- `artifacts/phase4-2e-server-rendered-tenant-isolation.md`

Untouched: `AIAgent/`, `package.json`, `package-lock.json`, `tsconfig.json`,
migration `0015`, all 4.2B/4.2C/4.2D sources.

---

## 16. Unresolved risks

1. **Observatory and Commercial read surfaces are still global.** Nine
   `src/lib/observatory/*` modules and the `src/lib/commercial/*` read services
   aggregate without a tenant filter. `/observatory` and the commercial API GETs
   can therefore show cross-tenant counts. This is the remaining gap and the
   recommended next phase.
2. **`npm test` does not discover the tenancy suites** (§13) — approval needed.
3. **PostgreSQL migration execution remains unverified** (§12).
4. **AgentLog/WorkflowRun/FailureRecord have no tenant column**; their partition
   is derived by id lists, so a very large tenant could approach parameter limits
   on the `in` clause (bounded today by the dashboard's take limits).
5. **`Product`/`Offer` are owned through relations**, so a product created with
   no opportunity is legacy-only and will never appear for a tenant — intended,
   but worth an explicit UI message when an admin creates unattributed data.
6. **No UI tenant selector**: a multi-tenant admin gets a `409` until the client
   sends `x-tenant-id`/`ail_tenant`.
7. **Storefront/public routes** intentionally serve published offers without a
   tenant scope; that is a product decision, not a regression.

---

## 17. Readiness matrix

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Protected server actions enforce tenant authorization | **IMPLEMENTED AND VERIFIED** | 5 action files; 16 surface tests; existing action-auth tests |
| 2 | Protected page loaders enforce tenant authorization | **IMPLEMENTED AND VERIFIED** | 10 loaders scoped; loader isolation tests |
| 3 | Dashboard aggregates tenant-scoped | **IMPLEMENTED AND VERIFIED** | stats/totals assertions (80/400/10) |
| 4 | Search and pagination tenant-scoped | **IMPLEMENTED AND VERIFIED** | partition is part of the same `where` as search/sort/take |
| 5 | Resource detail reads enforce ownership | **IMPLEMENTED AND VERIFIED** | `getOpportunity`, `getFactoryRunDetail`, revenue/experiment detail |
| 6 | Mutations enforce tenant ownership | **IMPLEMENTED AND VERIFIED** | `updateMany`/`deleteMany` + attachment guards |
| 7 | Bulk operations cannot mix tenants | **N/A / IMPLEMENTED** | no bulk endpoint exists; per-row guards would apply |
| 8 | Exports and downloads enforce ownership | **N/A** | no export/download surface exists (verified) |
| 9 | Tenant-specific cache boundaries safe | **N/A** | zero cache APIs in the codebase (verified) |
| 10 | Background execution remains tenant-scoped | **IMPLEMENTED AND VERIFIED** | 4.2D job/provenance suites still green |
| 11 | Approval/review protections intact | **IMPLEMENTED AND VERIFIED** | 4.2D approval matrix still green (`npm test`) |
| 12 | Existing isolation tests discoverable/reproducible | **BLOCKED** | `npm test` globs exclude `src/lib/tenancy`; needs `package.json` approval |
| 13 | Root regression tests green | **IMPLEMENTED AND VERIFIED** | 1863 tests, 1862 pass, 0 fail, 1 pre-existing skip; tsc 0; eslint 0 errors; build OK |
| 14 | PostgreSQL limitations documented | **DOCUMENTED (NOT VERIFIED)** | no Postgres binaries; no schema change in 4.2E |
| 15 | Observatory/commercial read isolation | **NOT IMPLEMENTED** | 9 observatory modules + commercial read services still global |

---

## 18. GitHub checkpoint readiness

- Branch `feat/handoff-receiver-finalization`, HEAD `caceac2`; nothing committed,
  pushed, deployed or force-pushed.
- Checkpoint candidate: the 17 modified + 4 added files in §15, plus the
  unchanged 4.2C/4.2D work already in the tree.
- Exclude: `AIAgent/` (independent tree at `main` @ `35afb7c`), pre-existing
  `package.json`/`package-lock.json`/`tsconfig.json`/`prisma/schema.test.prisma`
  edits, and environment logs (`.qa-*`, `.slice-*`, `artifacts/eslint-agg.mjs`).
- Awaiting approval for the checkpoint and for the two blocked items:
  the `package.json` test glob (one line) and a disposable PostgreSQL run of
  migration `0015`.
