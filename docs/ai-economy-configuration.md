# Phase 4.5.3 — Intelligent AI Economy: Configuration Reference

All new policy knobs are environment-configurable. Nothing is hardcoded to a
currency value; unset variables mean "unlimited / not configured" unless a safe
default is noted. Copy the relevant lines into `.env` (server-side only — none
of these are safe or intended for `NEXT_PUBLIC_` exposure).

## AI Efficiency Engine (`src/lib/ai/efficiency.ts`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `AI_MAX_REQUEST_INPUT_TOKENS` | `24000` | Per-request compression target (input tokens). Requests > 1.5× this are blocked pending compression. |
| `AI_DAILY_TOKEN_BUDGET` | unset (unlimited) | Global daily token budget (input+output). |
| `AI_MONTHLY_TOKEN_BUDGET` | unset (unlimited) | Global monthly token budget (input+output). |
| `AI_TOKEN_BUDGET_AGENT_<AGENT>` | unset (unlimited) | Per-agent daily token budget. Agent name upper-cased, non-alphanumerics → `_` (e.g. `AI_TOKEN_BUDGET_AGENT_BUSINESS_MANAGER`). |
| `AI_TOKEN_BUDGET_PURPOSE_<PURPOSE>` | unset (unlimited) | Per-purpose daily token budget (e.g. `AI_TOKEN_BUDGET_PURPOSE_RESEARCH_FINDINGS`). |
| `AI_CACHE_TTL_SECONDS` | `900` | TTL for cached validated AI results (explicit cacheKey only). Expired entries are never served. |
| `AI_DEDUP_WINDOW_SECONDS` | `60` | Window in which identical (provider, model, purpose, prompt, options) requests are prevented. |

Pre-existing budget guard (unchanged): `AI_DAILY_BUDGET_USD` (default `2.00`)
still blocks any single call whose estimated cost exceeds the daily USD budget.

## Agent Treasury (`src/lib/business/agent-treasury.ts`)

Internal accounting ONLY — no bank accounts, wallets, transfers, or payment
integrations exist anywhere in this phase.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TREASURY_OWNER_ALLOCATION_RATE` | `0.30` | Fraction of net revenue recorded as owner allocation (accounting). |
| `TREASURY_BUSINESS_RESERVE_RATE` | `0.50` | Fraction of net revenue recorded as business reserve (accounting). |
| `TREASURY_AI_OPERATING_BUDGET_RATE` | `0.10` | Fraction of net revenue routed to the AI operating budget bucket (accounting). |
| `TREASURY_GROWTH_REINVESTMENT_RATE` | `0.10` | Fraction of net revenue for growth reinvestment (accounting; the remainder is clamped here). |
| `TREASURY_REINVESTMENT_MARGIN_THRESHOLD` | `0.15` | Minimum contribution margin (0..1, deterministic BI layer) before a reinvestment RECOMMENDATION is allowed. |

The four rates must sum to ~1; `areTreasuryRatesConsistent()` reports otherwise.
Reinvestment output is always `requiresHumanApproval: true`,
`automaticTransfer: false`.

## Growth Engine thresholds (`src/lib/business/growth-engine.ts`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `GROWTH_MIN_SAMPLE_VISITORS` | `100` | Minimum recorded visitors before any winner/loser state is possible. |
| `GROWTH_MIN_REVENUE_USD` | `50` | Minimum recorded (profitable) revenue for `PROMISING`. |
| `GROWTH_MIN_REVENUE_PROVEN_USD` | `500` | Minimum recorded (profitable) revenue for `PROVEN`. |

Human decisions (experiment `PAUSE`/`KILL`, manual pause) always dominate
numeric classification. `TESTING` is the honest default with weak data.

## Behavior notes

- Efficiency counters (cache hits, prevented duplicates, estimated savings) are
  process-local estimates. They are surfaced on `/ai-usage` and `/api/ai/usage`
  with the `PROCESS_LOCAL_ESTIMATE` basis label and reset on restart.
- The dedup check returns a failed outcome with `blockedBy: 'dedup'`; the cache
  returns the validated value with `servedFromCache: true`. Neither performs a
  provider call.
- Token-budget blocks return `blockedBy: 'token_budget'` with the specific
  `budgetKind` (`request | daily | monthly | agent | purpose`).
