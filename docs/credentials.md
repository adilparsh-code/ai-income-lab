# AI Income Lab — Credentials & Environment Reference (Phase 8, Rule 10)

**All variables below are SERVER-SIDE ONLY.** None are prefixed `NEXT_PUBLIC_`,
none reach the browser bundle, none are ever logged, echoed into AI prompts, or
returned by any API. Real secrets are set through the platform's environment
mechanism (Settings → Environment / `freebuff-env`) and are never committed.

`.env.example` (in the repository root) mirrors this document with placeholder
values only. Without any credentials the platform stays fully functional in
honest `NOT_CONFIGURED` / `NOT_CONNECTED` / `MOCKED` modes, and fail-closed
endpoints refuse writes rather than pretending to work.

## Where to put real values

| Scope | Where | Notes |
| --- | --- | --- |
| Local / sandbox | `.env.local` (git-ignored) | Loaded automatically into dev, preview, and terminal sessions. |
| Production | Freebuff deploy env (`freebuff-deploy env set`) | Applied on the next production deploy; separate from sandbox values. |

## Required

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string for Prisma (Supabase transaction pooler in production). See `.env.example`. |

## AI provider (optional — mock mode when unset)

| Variable | Purpose | Behavior when missing |
| --- | --- | --- |
| `AI_PROVIDER` | `gemini` enables live AI; `mock` (default) uses the deterministic provider. | Mock provider; every AI output labelled MOCKED. |
| `GEMINI_API_KEY` | Gemini credential. | AI stays in mock mode; nothing fabricated. |
| `GEMINI_MODEL` | Model id (default `gemini-2.0-flash`). | Default model. |
| `AI_DAILY_BUDGET_USD` | Daily spend guard for the AI Usage center. | Budget shows as unlimited. |

## Research providers (optional — RESEARCH_UNAVAILABLE when unset)

| Variable | Purpose | Behavior when missing |
| --- | --- | --- |
| `RESEARCH_SEARCH_PROVIDER` | `searxng` (free, default) or `tavily`. | Discovery honestly reports RESEARCH_UNAVAILABLE. |
| `RESEARCH_SEARXNG_URL` | Your own SearXNG instance URL. | Public default instance (best-effort). |
| `TAVILY_API_KEY` | Tavily credential when `tavily` selected. | Tavily resolves to NOT_CONFIGURED. |

Search results are always SEARCH_DISCOVERY; only fetched + validated content
becomes VERIFIED_DATA. Brave remains a future adapter boundary.

## Publishing — Polar (Rule 5, optional)

| Variable | Purpose | Behavior when missing |
| --- | --- | --- |
| `POLAR_ACCESS_TOKEN` | Merchant-of-record API credential (Settings → API). | Adapter reports AUTH_REQUIRED; no external calls. |
| `POLAR_ORG_ID` | Optional organization scoping. | Token's default organization. |
| `POLAR_WEBHOOK_SECRET` | Standard Webhooks signing secret (`whsec_...`). | `POST /api/webhooks/polar` refuses every request (fail-closed 503). |

Publication claims `PUBLISHED` only after a verified provider round-trip
(create + confirm); each publish requires an explicit human approval token.

## Deployment — Vercel (Rule 4, optional)

| Variable | Purpose | Behavior when missing |
| --- | --- | --- |
| `VERCEL_TOKEN` | Deployment credential (scope-limited). | Deployment reports DEPLOYMENT_NOT_CONNECTED. |
| `VERCEL_TEAM_ID` / `VERCEL_PROJECT_ID` | Optional scoping. | Account-level default. |

## Operator endpoints (optional — fail-closed when unset)

| Variable | Purpose | Behavior when missing |
| --- | --- | --- |
| `OPERATOR_REVENUE_TOKEN` | Bearer token for `POST /api/revenue`. | Endpoint refuses all writes (503). |
| `OPERATOR_CONTROL_TOKEN` | Bearer token for control endpoints (jobs, workflows, ruflo/pipeline, operations POST, ai/usage). Falls back to `OPERATOR_REVENUE_TOKEN` when unset. | Control endpoints refuse (401/503). |
| `SECURITY_FINGERPRINT_SALT` | Salt for keyed HMAC credential fingerprints (audit correlation only). | Stable default salt. |
| `RUFLO_RUNTIME_TOKEN` | Bearer token for the Ruflo runtime API (`/api/ruflo/runtime/*`). See `docs/ruflo-runtime.md`. | Runtime API refuses (503); capability stays NOT_CONFIGURED. |
| `RUFLO_RUNTIME_ENABLED` | Must be `true` to register the runtime handle at startup (kill switch). | Handle not registered; posture AUTH_REQUIRED. |
| `RUFLO_RUNTIME_ID` | Non-secret audit label of the Ruflo runtime. | Defaults to `ruflo-runtime`. |
| `RUFLO_DISPATCH_TIMEOUT_MS` | Dispatch budget (1000–600000 ms). | Defaults to 120000. |

## Market configuration (Rule 9 — non-secret)

| Variable | Purpose |
| --- | --- |
| `AI_INCOME_MARKET` | `GLOBAL` (default) or `IN`. Gates which provider adapters are configuration-available per market; never changes business logic or safety gates. |

## Security checklist (audited in Phase 8)

- [x] No `NEXT_PUBLIC_*` secrets; browser bundle contains no credentials.
- [x] Webhook secrets verified over the raw body; constant-time comparisons.
- [x] Fail-closed endpoints: revenue ingestion, payment webhooks.
- [x] Authorization ledger never returns token material; expired grants are
      never silently reused.
- [x] Provider round-trip verification before any LIVE claim (Rule 2).
