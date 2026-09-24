# Agent Memory

Status: **implemented and tested**.

The existing durable memory foundation is retained and extended through `src/lib/operations/operations-summary.ts` for mission/recovery context. Memory is domain-specific, bounded, timestamped, scope-filtered, and provenance-preserving. It is derived from AgentLog, Experiment, Product, Revenue, and JobRun records; there is no unrestricted chat-history store.

Categories cover verified facts, user-entered data, AI inference, experiment results, business decisions, failed hypotheses, and successful patterns. `VERIFIED_DATA` is never upgraded by an AI interpretation. Retrieval favors verified/user evidence over weaker signals.

Human approval and safety gates are memory context, not permissions. Memory cannot authorize publishing, deployment, spending, or lifecycle override.
