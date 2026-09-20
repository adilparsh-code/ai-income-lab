# Production Credentials Checklist

**CODE COMPLETE vs PRODUCTION CONFIGURATION REQUIRED** — the code is complete
and tested for every item below; each capability reports truthful
NOT_CONFIGURED / MOCKED status until its credential exists. No real secrets
belong in this repository. All credentials are **server-side only** (never
`NEXT_PUBLIC_*`, never in logs, API responses, or client bundles).

## Status legend

- ✅ configured — capability may verify a real round-trip
- ⬜ NOT CONFIGURED — code ready, waiting on the credential
- ➖ not applicable yet — later phase

## Checklist

| Capability | Status | Credential / configuration | Notes |
|---|---|---|---|
| AI Provider (Gemini) | ⬜ NOT CONFIGURED | `AI_PROVIDER=gemini` + `AI_PROVIDER_API_KEY` | Generation stays deterministic/MOCKED without it; never labeled live |
| AI daily budget (optional) | ⬜ NOT SET | `AI_DAILY_BUDGET_USD` | Unset = reported honestly as unlimited; never fabricated |
| Research: SearXNG | ⬜ NOT CONFIGURED | `RESEARCH_SEARXNG_URL` (own instance) | Default public instance bot-blocks the JSON API |
| Research: Tavily (alternative) | ⬜ NOT CONFIGURED | `TAVILY_API_KEY` | Optional second provider |
| Operator control token | ⬜ NOT CONFIGURED | `OPERATOR_CONTROL_TOKEN` (or `OPERATOR_REVENUE_TOKEN`) | Required for operator APIs; fail-closed 503 without it |
| Security fingerprint salt | ⬜ NOT SET (recommended) | `SECURITY_FINGERPRINT_SALT` | Falls back to a stable default until set |
| Ruflo runtime | ⬜ NOT CONFIGURED | `RUFLO_RUNTIME_TOKEN` + `RUFLO_RUNTIME_ENABLED=true` | Activation commands in `docs/ruflo-runtime.md` |
| Ruflo runtime id (optional) | ➖ | `RUFLO_RUNTIME_ID` | Non-secret audit label |
| Payments (Polar) | ➖ Phase C | `POLAR_ACCESS_TOKEN` + `POLAR_WEBHOOK_SECRET` | Webhook signature verification already implemented |
| Publishing | ➖ Phase C | Provider credential per channel | Requires verified provider round-trip + human approval before LIVE |
| Deployment (Vercel) | ⬜ NOT CONFIGURED | `VERCEL_TOKEN` | Human approval token still required per deployment |
| Halal policy version label | ⬜ OPTIONAL | `HALAL_POLICY_VERSION` | Defaults to `halal-filter-v1`; label only, no secret |

## Generation / verification rules (unchanged)

- An API key present ≠ LIVE. Only a verified provider round-trip flips a
  capability to LIVE; everything else stays honestly NOT_CONFIGURED.
- Never commit real credentials; never paste them into issues, logs, or the
  browser bundle.
- Set secrets through the deployment environment (Settings → Environment /
  `freebuff-deploy env set`), not in `.env` files committed to Git.
