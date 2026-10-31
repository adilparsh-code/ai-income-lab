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
| `DATABASE_URL` | PostgreSQL connection string for Prisma, used through `@prisma/adapter-pg` (a standard PostgreSQL URL). The production provider is not recorded in this repository — operator to confirm. `.env.example` shows Supabase-shaped examples. |
| `DIRECT_URL` | Direct/session PostgreSQL connection used by the Prisma 7 CLI for `prisma7 migrate status` and `prisma7 migrate deploy` (the transaction pooler rejects the CLI engine). Falls back to `DATABASE_URL`, but the CLI must not run through port 6543. |

Database verification steps and the migration inventory live in
[`docs/database-operations.md`](./database-operations.md). Both variables must
be supplied from the project's authorized PostgreSQL provider and are
never committed; `.env.example` carries placeholders only. Percent-encode
URL-special characters in the password (`@ : / ? # & %`…) or the connection
string will not parse.

## Admin authentication (single administrator — required for any login)

| Variable | Purpose | Behavior when missing |
| --- | --- | --- |
| `ADMIN_EMAIL` | The single admin identity (not a secret). | Login refused (fail-closed). |
| `ADMIN_PASSWORD_HASH` | scrypt hash `scrypt:<salt>:<hash>` from `node scripts/hash-admin-password.mjs`. Always wins over `ADMIN_PASSWORD`. | Falls back to `ADMIN_PASSWORD`, else login refused. |
| `ADMIN_PASSWORD` | Bootstrap plaintext fallback. Do not use in production. | Ignored when a hash is set. |
| `ADMIN_REQUIRE_PASSWORD_HASH` | Truthy → plaintext `ADMIN_PASSWORD` is ignored (migration switch; can only remove a credential path). | Plaintext fallback allowed. |
| `ADMIN_DISABLED` | Truthy → kill switch, every admin login refused. | Admin enabled. |
| `ADMIN_SESSION_TTL_MS` | Absolute session lifetime, bounded 30 min – 7 days. | 12 hours. |
| `LOGIN_LOCKOUT_IP_MAX_FAILURES` | Per-IP failed-login ceiling (3–20). | 5. |
| `LOGIN_LOCKOUT_ACCOUNT_MAX_FAILURES` | Account-wide failed-login ceiling (10–100). | 20. |
| `LOGIN_LOCKOUT_WINDOW_SECONDS` | Lockout window (300–3600). | 900. |

## Supabase client (optional — currently unused by this codebase)

| Variable | Purpose | Behavior when missing |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL for a future browser/SSR Supabase client (`https://<project-ref>.supabase.co`). | Nothing reads it today; no effect. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key (`sb_publishable_…`) for that client. | Nothing reads it today; no effect. |

Client-safe by design (both are delivered to browsers), but they are still
environment values, not database credentials. A database password, an
`sb_secret_…` key, or a legacy `service_role` key must never carry a
`NEXT_PUBLIC_` prefix — everything with that prefix is embedded in the client
bundle. Server-side data access stays on `DATABASE_URL` above.

## AI provider (optional — mock mode when unset)

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:4989d336d24878ca3cb089978581bdd5db27074283c388ef95e57ac3aa3e0f8a -->

| Variable | Purpose | Behavior when missing |
| --- | --- | --- |
| `AI_PROVIDER` | `gemini` enables live AI; `mock` (default) uses the deterministic provider. | Mock provider; every AI output labelled MOCKED. |
| `AI_PROVIDER_API_KEY` | Gemini credential (server-only; read in `src/lib/ai/generate.ts`). | AI stays in mock mode; nothing fabricated. |
| `AI_MODEL_*` | Optional per-purpose model overrides: `AI_MODEL_RESEARCH`, `AI_MODEL_VALIDATION`, `AI_MODEL_PRODUCT`, `AI_MODEL_ANALYTICS_NARRATIVE`, `AI_MODEL_BM_NARRATIVE` (model names only, no secrets). | Default Gemini model. |
| `AI_DAILY_BUDGET_USD` | **Per-request estimated-cost ceiling** in USD (positive number), despite the name. The generation gate (`getDailyBudgetUsd` in `src/lib/ai/models.ts`, checked in `src/lib/ai/generate.ts`) blocks a single request whose estimated cost exceeds it. It does **not** add up earlier usage, so it is **not** an aggregate daily spend cap; many requests that each fit under it all pass. The AI Usage page displays today's estimated spend separately from the ceiling. | Unset or invalid: the generation gate uses **$2.00**, and the AI Usage page identifies the default per-request ceiling. |
| `AI_TIMEOUT_MS` | Per-request generation timeout in ms (positive integer). | 25000. |
| `AI_MAX_RETRIES` | Generation retries (positive integer, capped at 5). | 2. |

<!-- /coderabbit-ai-generated:v1 -->

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
| `OPERATOR_REVENUE_TOKEN` | Bearer token for `POST /api/revenue` ONLY. Hand this to revenue-ingestion automation; it grants no control-plane access. | Endpoint refuses all writes (503). |
| `OPERATOR_CONTROL_TOKEN` | Bearer token for control endpoints (jobs, workflows, ruflo/pipeline, operations POST, ai/usage). **No fallback**: it is never derived from `OPERATOR_REVENUE_TOKEN`. Must be a different value from `OPERATOR_REVENUE_TOKEN` — if both are set to the same value, both endpoints refuse (503). Generate each with e.g. `openssl rand -base64 48`. | Control endpoints refuse (503). |
| `SECURITY_FINGERPRINT_SALT` | Salt for keyed HMAC credential fingerprints (audit correlation only). | Stable default salt. |
| `RUFLO_RUNTIME_TOKEN` | Bearer token for the Ruflo runtime API (`/api/ruflo/runtime/*`). See `docs/ruflo-runtime.md`. | Runtime API refuses (503); capability stays NOT_CONFIGURED. |
| `RUFLO_RUNTIME_ENABLED` | Must be `true`, `1` or `yes` (case-insensitive) to register the runtime handle at startup (kill switch). | Handle not registered; posture AUTH_REQUIRED. |
| `RUFLO_RUNTIME_ID` | Non-secret audit label of the Ruflo runtime. | Defaults to `ruflo-runtime`. |
| `RUFLO_DISPATCH_TIMEOUT_MS` | Dispatch budget (1000–600000 ms). | Defaults to 120000. |
| `RUFLO_MCP_URL` | **Outbound** base URL of a Ruflo V3 HTTP/MCP server that this app calls (distinct from the inbound runtime API above). | Outbound client not configured; no network calls. |
| `RUFLO_MCP_TOKEN` | Bearer token for that outbound Ruflo server (optional). | Calls sent without a token. |
| `RUFLO_MCP_TIMEOUT_MS` | Outbound call timeout in ms. | 10000. |
| `RUFLO_RESEARCH_FRESHNESS_DAYS` | Window (days, positive number) in which existing research is reused. | 14 (also used for invalid or non-positive values). |

## External agent credentials (Agent Integration Contract v1, optional — API refuses when unset)

Dedicated server-to-server credentials for external AI agent runtimes. See
[`docs/agent-contract-v1.md`](./agent-contract-v1.md) for the full contract.
One binding per agent; `<NAME>` is an `A–Z 0–9 _` label:

| Variable | Purpose | Behavior when missing |
| --- | --- | --- |
| `AGENT_<NAME>_TOKEN` | Bearer secret for one agent binding (e.g. `AGENT_RESEARCH_LAB_TOKEN`). | Binding ignored. With no bindings at all, `/api/agent/v1/*` refuse (503 NOT_CONFIGURED). |
| `AGENT_<NAME>_ID` | Non-secret identity bound to that token. Required for the binding to count. | Binding ignored (fail-closed, never guessed). |
| `AGENT_<NAME>_CAPABILITIES` | Capability grant: comma-separated ids or `*`. | Empty grant → every action refused (403). |
| `AGENT_RATE_LIMIT_PER_MINUTE` | Durable per-credential action cap (1–300) on `/api/agent/v1/actions`. | 30. |

Agents never receive database, Prisma, or operator credentials — only the
bearer token above, and only the capabilities in its grant. The token is never
logged or stored; audit rows keep a keyed HMAC fingerprint. Rotation = set a
new token value (effective on the next request).

## Market configuration (Rule 9 — non-secret)

| Variable | Purpose |
| --- | --- |
| `AI_INCOME_MARKET` | `GLOBAL` (default) or `IN`. Gates which provider adapters are configuration-available per market; never changes business logic or safety gates. |

## Additional optional variables (reconciled in Phase 1)

Values below are read in the cited source files. "Invalid" means non-numeric or out of range.

| Variable | Purpose and allowed values | Default when unset or invalid |
| --- | --- | --- |
| `NEXT_PUBLIC_APP_NAME` | Client-safe display name (never a secret). `src/lib/config.ts`. | "AI Income Lab" |
| `NEXT_PUBLIC_APP_URL` | Public base URL for event/revenue callbacks. Only the Vercel deployment adapter's readiness check reads it (`product-factory/deployment-vercel.ts`). | Readiness reports it as missing. |
| `NEXT_PUBLIC_SITE_PROTOCOL` | Exactly `https:` or `http:`; decides whether HSTS is sent (`src/middleware.ts`). | HSTS is sent when `NODE_ENV=production`, otherwise not. |
| `AI_DAILY_TOKEN_BUDGET`, `AI_MONTHLY_TOKEN_BUDGET` | Token budgets (positive number, floored), checked against a **process-local in-memory** ledger (`src/lib/ai/efficiency.ts`) that resets at 00:00 UTC and on restart and is not shared across server instances. Despite its name, `AI_MONTHLY_TOKEN_BUDGET` is therefore **not** a durable monthly budget: it behaves like a per-process, per-UTC-day guard. Usage is recorded after a call finishes, so concurrent requests can pass the pre-check together. | Not enforced when unset. |
| `AI_MAX_REQUEST_INPUT_TOKENS` | Per-request input-token ceiling (positive number). | 24000. |
| `AI_TOKEN_BUDGET_AGENT_<AGENT>`, `AI_TOKEN_BUDGET_PURPOSE_<PURPOSE>` | Per-agent / per-purpose daily token budgets (positive number). The suffix is the id upper-cased with non-alphanumerics as `_`, e.g. `AI_TOKEN_BUDGET_AGENT_BUSINESS_MANAGER`, `AI_TOKEN_BUDGET_PURPOSE_PRODUCT_CONCEPT`. | Not enforced. |
| `GROWTH_PROVEN_REVENUE_MINOR`, `GROWTH_PROMISING_REVENUE_MINOR`, `GROWTH_MIN_VISITORS_MINOR` | Growth-classification thresholds (number ≥ 0; revenue in minor currency units). `product-factory/events.ts`. | 50000 / 5000 / 30 |
| `BUILDER_MAX_ATTEMPTS` | Sandboxed product-builder attempts (integer 1–5). | 2 |
| `AI_LIVE_TESTS`, `RUFLO_LIVE_TEST_URL`, `RUFLO_LIVE_TEST_TOKEN`, `AGENT_HEALTHTEST_*` | Test and CI only; only test files and CI read them. Never set in production. | Live tests are skipped. |

Variables already documented in the sections above (`AI_PROVIDER*`, `AI_DAILY_BUDGET_USD`, `RESEARCH_*`, `TAVILY_API_KEY`, `POLAR_*`, `VERCEL_*`, `AI_INCOME_MARKET`) are intentionally not repeated here.

## Security checklist (audited in Phase 8)

- [x] No `NEXT_PUBLIC_*` secrets; browser bundle contains no credentials.
- [x] Webhook secrets verified over the raw body; constant-time comparisons.
- [x] Fail-closed endpoints: revenue ingestion, payment webhooks.
- [x] Authorization ledger never returns token material; expired grants are
      never silently reused.
- [x] Provider round-trip verification before any LIVE claim (Rule 2).

## Deployment configuration changes required by the security remediation

1. **Set `OPERATOR_CONTROL_TOKEN`** (distinct from `OPERATOR_REVENUE_TOKEN`) in the Production environment *before* deploying. Deployments that relied on the revenue-token fallback will otherwise get 503 on control endpoints.
2. Existing callers of control endpoints must switch to the new control token.
3. Apply migration `0013_approval_grants_and_halal_reviews` (production build runs `prisma migrate deploy` when `VERCEL_ENV=production`). Preview deployments no longer migrate; give previews their own database.
4. Rotate any credential that was ever committed or pasted elsewhere. Never commit token values.
