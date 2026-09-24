# Agent Memory (Operational)

Status: IMPLEMENTED / TESTED

Structured operational memory — not chat history.

Categories: `opportunity product experiment failure market agent provider`

Each entry: source, timestamp, evidence/confidence classification, related entity, observation, outcome, applicability.

## Provenance rule

Memory without sufficient provenance is **not** treated as verified truth.

`treatedAsVerified` is true only when:

- evidence type ranks at `VERIFIED_DATA`, and
- source is present and is not `ai` / `inference` / `chat`

`recallOperationalMemory({ verifiedOnly: true })` filters to that subset. AI inference can be stored, but it cannot be promoted.

This layer is additive to the existing Phase 5.2 derived memory (`src/lib/agents/memory-store.ts`), which remains the read model over AgentLog / Experiment.

## Labels

| Path | Status |
|---|---|
| OperationalMemory table + recall | IMPLEMENTED / TESTED |
| Derived AgentLog memory | IMPLEMENTED (Phase 5.2, reused) |
| Unrestricted conversational memory | Not implemented (structurally refused) |
