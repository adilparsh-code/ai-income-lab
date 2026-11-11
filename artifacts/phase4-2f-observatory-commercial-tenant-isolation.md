# Phase 4.2F — Observatory & Commercial Tenant Isolation

## 1. Executive summary
- Status: **IMPLEMENTED AND VERIFIED** for all nine Observatory modules and the Commercial read services touched.
- Scope: root AI Income Lab only. No commits, pushes, deployments, migrations, dependency changes, or `package.json` changes.
- All read queries now enforce tenant boundaries at the database query level using existing `resolveTenantScope` / `currentScope` / `relation-scope` helpers.
- New focused cross-tenant test: `src/lib/tenancy/__tests__/observatory-commercial-isolation.test.ts` (3 tests, all passing).
- Validation: `npm test` 1863 tests / 1862 pass / 1 skip / 0 fail; `npx tsc --noEmit` exit 0; `npx eslint .` 0 errors (4 pre-existing warnings); `npm run build` compiled successfully.

## 2. Initial Git baseline
- Branch: `feat/handoff-receiver-finalization`, HEAD `caceac2`.
- Working tree preserved; all prior modifications retained. No destructive Git operations performed.

## 3. Project-instruction compliance
- Reused existing scope authority (`src/lib/tenancy/scope.ts`, `action-scope.ts`, `relation-scope.ts`); no duplicate authorization framework.
- No client-controlled tenant IDs trusted; scope resolved server-side.
- No `package.json` / `package-lock.json` modifications.
- No AIAgent modifications.
- No production credentials or migrations.

## 4. Observatory modules (reconciled in Phase 4.2G)

Actual module files under `src/lib/observatory/`: `agent-overview.ts`, `control-reflection.ts`, `executive-view.ts`, `integration-health.ts`, `learning.ts`, `pnl.ts`, `safety-map.ts`, `timeline.ts`, `index.ts` (orchestration). `customer-interactions` is a function inside `safety-map.ts`, not a separate module; `integration-health.ts` performs only a `SELECT 1` health check and capability descriptors (global by design, no tenant rows).

Tenant-sensitive modules scoped in 4.2F (8): agent-overview, pnl, timeline, learning, safety-map (incl. customer interactions/publishing), control-reflection, executive-view, index (orchestration).

| # | Module | File | Status |
|---|--------|------|--------|
| 1 | Agent overview | `src/lib/observatory/agent-overview.ts` | Scoped `AgentLog` cost rows via `agentLogWhere` |
| 2 | P&L | `src/lib/observatory/pnl.ts` | Scoped Revenue + AgentLog via `revenueWhere`/`agentLogWhere` |
| 3 | Timeline | `src/lib/observatory/timeline.ts` | All table queries scoped |
| 4 | Learning | `src/lib/observatory/learning.ts` | `learningEntry`, `growthExperiment`, `productEvent` scoped |
| 5 | Safety map | `src/lib/observatory/safety-map.ts` | opportunity/product/revenue/handoff/deployment/event scoped |
| 6 | Control reflection | `src/lib/observatory/control-reflection.ts` | `humanReview` scoped |
| 7 | Executive view | `src/lib/observatory/executive-view.ts` | Composed calls receive scope; `humanReview` scoped |
| 8 | Orchestration | `src/lib/observatory/index.ts` | `getObservatoryView(scope)` propagates scope to all composed modules |
| — | Integration health | `src/lib/observatory/integration-health.ts` | Global by design (health check + capability descriptors; no tenant data) |

## 5. Commercial services inventory
- `src/lib/commercial/commercial-summary.ts` — `getCommercialSummary(scope)` now scopes prospects, offers, proposals, scope-change requests, service engagements, milestones, deliverables, service issues, revenue, learning entries.
- `src/lib/commercial/commercial-learning.ts` — `deriveCommercialSignals(scope)` now scopes proposals, scope-change requests, service engagements, deliverables, revenue, engagement costs, offers, offer halal group-by.

## 6. Files changed
- `src/lib/observatory/agent-overview.ts`
- `src/lib/observatory/pnl.ts`
- `src/lib/observatory/timeline.ts`
- `src/lib/observatory/learning.ts`
- `src/lib/observatory/safety-map.ts`
- `src/lib/observatory/control-reflection.ts`
- `src/lib/observatory/executive-view.ts`
- `src/lib/observatory/index.ts`
- `src/lib/commercial/commercial-summary.ts`
- `src/lib/commercial/commercial-learning.ts`
- `src/app/api/observatory/route.ts`
- `src/app/api/commercial/summary/route.ts`
- `src/app/(admin)/observatory/page.tsx`
- `src/lib/tenancy/__tests__/observatory-commercial-isolation.test.ts` (new)

## 7. Ownership relationships
- Revenue → Opportunity OR Product → Opportunity.
- Offer → Opportunity OR Product → Opportunity.
- ServiceEngagement → Offer → Opportunity/Product → Opportunity.
- Proposal → Opportunity.
- Prospect → Opportunity.
- Milestone/Deliverable/ServiceIssue → ServiceEngagement → Offer → Opportunity.
- LearningEntry → Opportunity/Experiment → Opportunity/Product.
- All via existing relation-scope helpers; no new joins invented.

## 8. Query-level tenant filtering evidence
- Every aggregate/count uses Prisma `where` clauses derived from scope (e.g. `revenueWhere(scope)`, `productWhere(scope)`), not post-filtering.
- Legacy scopes yield `{ tenantId: null }`-style disjoint filters; tenant scopes yield `{ tenantId }` / relation filters.
- Foreign IDs resolve to empty result sets (safe 404 semantics preserved).

## 9. Aggregate isolation evidence
- P&L gross revenue totals verified per-tenant in new test.
- Commercial summary offer totals verified per-tenant in new test.
- Legacy scope returns null revenue total (disjoint from tenant rows).

## 10. Legacy partition verification
- Legacy principals see only legacy rows; tenant members do not see legacy rows; suspended memberships fail closed (existing Phase 4.2D behavior preserved).

## 11. Global administration verification
- Global metrics remain available only via explicit global authority; ordinary tenant admins receive scoped results. No escalation path introduced.

## 12. Security test matrix
- New: `observatory-commercial-isolation.test.ts` — 3 tests, all pass.
- Existing: tenancy suite 42 tests pass when run explicitly; observatory test 17 pass; commercial DB/economics/gap suites pass.

## 13. Calculation regression results
- No calculation logic changed; only `where` filters added. Existing observatory (17) and commercial (37+38+34) tests pass unchanged.

## 14. Exact validation commands and counts
- `npx tsc --noEmit` → exit 0.
- `npx eslint .` → 0 errors, 4 pre-existing warnings.
- `npm run build` → compiled successfully.
- `npm test` → 1863 tests, 1862 pass, 1 skip, 0 fail (new isolation test not in default discovery; run explicitly).
- `npx tsx --test src/lib/tenancy/__tests__/observatory-commercial-isolation.test.ts` → 3 pass, 0 fail.

## 15. Remaining gaps
- New isolation test is not discovered by default `npm test` (package.json unchanged per restriction). Run explicitly.
- PostgreSQL execution of migration 0015 remains unverified (no Postgres binaries).

## 16. Readiness matrix
- Observatory modules: IMPLEMENTED AND VERIFIED.
- Commercial read services: IMPLEMENTED AND VERIFIED.
- Cross-tenant tests: IMPLEMENTED AND VERIFIED (explicit run).
- Legacy partition: IMPLEMENTED AND VERIFIED.
- Global admin: IMPLEMENTED AND VERIFIED.
- Postgres migration: NOT VERIFIED (environment).

## 17. GitHub checkpoint readiness
- Ready for approval; no commit/push performed.
PY
echo "report written"