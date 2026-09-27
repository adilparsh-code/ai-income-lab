# AI Income Lab — Security Hardening Additions (Phase 9, additive)

The Phase 9 hardening on `main` (commit `c3d8545`, "Security Hardening:
defense-in-depth for API, payments, AI and data layers") already covers the API
boundary, durable rate limiting, security headers/middleware, body and JSON
guards, the operator-auth model, the audit trail, the fingerprint fix and the
`$queryRawUnsafe` removal.

This change **adds four gaps** that commit did not touch. It is deliberately
additive: no existing module is rewritten, no existing control is replaced, and
nothing in `src/lib/security/guard.ts` or `src/middleware.ts` is modified.

## 1. SSRF protection at the DNS layer

`src/lib/security/ssrf.ts` (new) + `src/lib/research/fetcher.ts` (wired in).

The existing research URL guard classifies hostname *strings*. That is
necessary but not sufficient: a syntactically public hostname can resolve into
private space (DNS rebinding, hostile `A` records, a `CNAME` into RFC1918), and
the fetcher would then follow it.

- Every research URL is resolved and **any** private, loopback, link-local,
  CGNAT (`100.64/10`), multicast, reserved, unique-local (`fc00::/7`),
  link-local IPv6, NAT64, documentation-range or IPv4-mapped address blocks the
  fetch *before* a request is issued.
- Applies to the initial URL **and every redirect hop**.
- Failure posture is fail-closed: a resolution failure refuses the fetch.
- The resolver is injectable, so tests never touch the network.

## 2. External research content is fenced as untrusted data

`src/lib/security/untrusted-content.ts` (new) + `src/lib/research/engine.ts`
(wired into the synthesis prompt).

Research snippets and fetched page text are third-party content. They are now
normalized (control/zero-width/bidi characters stripped, length bounded),
scanned for instruction-shaped payloads (override attempts, role hijack, chat
template tokens, secret exfiltration, safety/halal-gate bypass requests), and
wrapped in `<<<UNTRUSTED_DATA …>>>` fences whose boundary tokens are neutralized
inside the content so a payload cannot forge an early close. A preamble states
that the block is data and never instructions, and the model is told how many
injection signals were detected.

Nothing is silently dropped: dropping evidence would corrupt the research
record. Detection is a signal; fencing is what makes the content inert.

## 3. Webhook raw body is bounded, and verdicts are classified correctly

`src/lib/security/body.ts` (new) + `src/app/api/webhooks/polar/route.ts` +
`src/lib/integrations/webhook-verification.ts`.

- The webhook's raw body (which must stay byte-identical for HMAC verification)
  is now read with a **streaming byte cap** plus a `Content-Length` pre-check,
  bounded at 1 MiB. `guard.readJsonBody()` could not be reused here: it is
  JSON-oriented and reads via `request.text()`, so a chunked body with no
  `Content-Length` would not be bounded. Oversized bodies are refused with
  `413 PAYLOAD_TOO_LARGE` and audited.
- `verifyProviderWebhook()` now classifies a failed Standard-Webhooks signature
  with **no** legacy `polar-signature` header as `BAD_SIGNATURE`. Previously it
  reported `MISSING_HEADERS`, which misdescribed a request that arrived with a
  signature and failed it. The legacy fallback still runs when a legacy header
  is actually present.
- Refused/rejected webhook events are recorded through the existing
  `auditSecurityEvent()` trail. Signature verification, replay protection,
  idempotency and product/amount/currency validation are unchanged.

## 4. Regression tests

New hermetic suites (no database, no network, no AI):

| File | Covers |
|------|--------|
| `src/lib/security/__tests__/ssrf.test.ts` | IPv4/IPv6 private-range classification, host syntax, DNS rebinding block, fail-closed resolution, end-to-end `fetchPage` refusal |
| `src/lib/security/__tests__/untrusted-content.test.ts` | injection detection, normalization, fence neutrality (forged close tokens), bounding, preamble |
| `src/lib/security/__tests__/request-body.test.ts` | JSON content-type detection, declared **and streamed** size caps, malformed JSON, SQLi payloads staying inert data |
| `src/lib/security/__tests__/webhook-boundary.test.ts` | 413 on oversized webhook body, 503 `MISSING_SECRET`, 401 `BAD_SIGNATURE` (not `MISSING_HEADERS`), stale-timestamp replay refusal, signed non-paid event ignored without ledger access |

## Verification

```
npm test          # full suite, all green (existing 793 + 38 new)
npm run typecheck # tsc --noEmit, clean
npm run lint      # eslint, clean
npm run build     # next build, succeeds
```

## Still required for production

Unchanged from the Phase 9 review, and worth repeating:

1. **End-user authentication for the dashboard is still absent.** Put the app
   behind platform authentication (SSO / access proxy) before exposing it.
2. Set `OPERATOR_CONTROL_TOKEN` (and `OPERATOR_REVENUE_TOKEN`) and
   `POLAR_WEBHOOK_SECRET` in the deployment environment, or the corresponding
   endpoints stay fail-closed.
3. The CSP still permits inline script/style (App Router interim posture).
4. Application-level limits complement — but do not replace — edge/WAF
   protection against volumetric abuse.
