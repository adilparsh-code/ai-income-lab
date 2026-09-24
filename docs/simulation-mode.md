# Simulation Mode

Status: **implemented and tested**.

Simulation accepts a deterministic seed, traffic, conversion rate, price, and costs. It returns `mode: SIMULATED`, calculated conversions, revenue, costs, profit, and a fixed no-real-action note. Repeating the same input produces the same result.

`/api/operations/simulate` is guarded, validates numeric inputs, and never writes a `Revenue` or `ProductEvent` row. The output is paper income only.

Lifecycle decisions treat simulated evidence as non-authoritative. A human decision is authoritative; otherwise simulated results route to `HUMAN_REVIEW`.

Implemented: `src/lib/operations/simulation.ts`, `/operations`, and primitive tests.
