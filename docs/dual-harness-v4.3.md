# AI Income Lab — Dual Harness Integration (v4.3)

## Purpose

AI Income Lab will support two complementary external agent harnesses:

1. **Ruflo** — orchestration, swarms, routing, memory and coordinated agent work.
2. **Prime Agent** — long-running autonomous coding/research work, persistent sessions and recursive subagents.

The two runtimes are workers/orchestrators. They do **not** own AI Income Lab business state.

## Authority boundary

AI Income Lab remains authoritative for:

- Opportunity/Product/Experiment/Revenue state
- lifecycle transitions
- halal screening and hard blocks
- human-review gates
- job idempotency and correlation IDs
- AI budgets and cost attribution
- publishing/deployment approval
- audit logs and provenance
- real revenue ingestion

Neither Ruflo nor Prime Agent may bypass these controls.

## Parallel execution

Both runtimes may operate at the same time when work is independent.

Example:

- Ruflo coordinates market research and validation.
- Prime Agent works on a product implementation or technical asset.
- AI Income Lab records each job separately using unique correlation/idempotency keys.
- Downstream actions wait for the required gates and dependencies.

The system must **not** run the same logical job twice merely because two harnesses are connected.

## Prime Agent integration model

Prime Agent currently supports JSON/RPC modes and persistent/daemon-backed sessions. AI Income Lab therefore uses a narrow server-side connector rather than embedding Prime Agent as a package.

The connector:

- registers a trusted runtime handle server-side;
- accepts only the existing workflow contract;
- delegates execution to the existing workflow runner;
- sends a bounded completion summary back to Prime Agent;
- never accepts arbitrary shell commands or code;
- never receives credentials through the workflow contract.

## Ruflo integration model

The existing Ruflo connector remains the Ruflo boundary. It also delegates execution through the same application-owned workflow runner.

## Human access layer

The user can separately configure external platform accounts, OAuth/API connections, payment providers, publishing accounts and 2FA. Those credentials stay server-side and are never passed through agent prompts.

## Rollout

### Stage A — Contract

- Prime Agent connector
- unified harness capability model
- documentation
- no external runtime claimed as connected

### Stage B — Local connection

- install/configure Ruflo and Prime Agent outside the application
- register trusted server-side handles
- verify status and completion callbacks

### Stage C — Parallel workflows

- assign independent tasks to Ruflo and Prime Agent
- enforce unique correlation IDs
- validate idempotency and dependency gates
- record costs and outcomes

### Stage D — 4.3 automation

- external research
- product asset creation
- listing preparation
- platform publishing through authorized providers
- traffic/marketing automation
- measurement and optimization

## Safety note

Prime Agent and Ruflo are orchestration/execution environments, not substitutes for a security sandbox. Prime Agent's own documentation states that model-generated Python/project commands run with user permissions; Ruflo also provides broad agent/tool capabilities. Use trusted repositories, skills and extensions, and keep irreversible actions behind AI Income Lab's existing approval boundaries.
