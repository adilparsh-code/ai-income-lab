# Ruflo Integration — v4.3

## Purpose

Ruflo is an orchestration layer for AI Income Lab. It must not replace the existing opportunity, product, experiment, revenue, or agent-log domain model.

## Target lifecycle

`DISCOVER → RESEARCH → VALIDATE → DECIDE → BUILD → PUBLISH → MARKET → MEASURE → IMPROVE`

The lifecycle is intentionally category-agnostic. Opportunities may be digital products, printable/aesthetic products, children's activities, SaaS, services, content, affiliate models, or other legitimate income opportunities.

## Responsibilities

### AI Income Lab
- Owns domain state and business rules.
- Stores opportunities, products, experiments, revenue, and agent logs.
- Provides the application/API surface.

### Ruflo orchestration layer
- Coordinates specialized agents.
- Routes work according to opportunity type and lifecycle state.
- Runs bounded workflows and quality gates.
- Coordinates retries and handoffs.
- Provides a future integration point for persistent agent memory and learning.

### Agents
- Researcher: gathers market evidence.
- Validator: evaluates demand, competition, monetization, automation, differentiation, startup cost, and halal confidence.
- Builder: creates the selected product/business artifact.
- Publisher: prepares and publishes listings/content/deployments where authorized.
- Marketing: executes bounded promotion workflows.
- Analyst: measures experiments, sales, revenue, costs, and profit.
- Optimizer: proposes or executes bounded improvements.

## Safety boundaries

Autonomy is bounded. Research, analysis, drafting, testing, and low-risk generation can be autonomous. Publishing, pricing, spending, account changes, and external transactions must use explicit policy/permission gates.

Ruflo is not treated as a security sandbox. Untrusted code, repositories, prompts, and extensions must not receive unrestricted execution permissions.

## Integration strategy

1. Preserve the v4.2.2 baseline.
2. Introduce orchestration behind a narrow internal interface.
3. Keep domain actions independent from Ruflo-specific APIs.
4. Add one end-to-end workflow before enabling broad autonomy.
5. Measure success by completed validated opportunities, cost, failures, revenue, and profit—not agent activity volume.
6. Expand orchestration only after the pilot passes tests.
