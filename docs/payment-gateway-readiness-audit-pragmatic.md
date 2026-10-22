# AI Income Lab — Payment Gateway Readiness Audit (Polar First)

**Scope:** read-only audit of the existing Polar integration and seller/payout eligibility for the owner's stated profile (India-based individual, Indian savings bank account, no current account, selling eligible digital products to Indian + international customers).

**Rule for this document:** configuration and code are inspected directly; eligibility claims are grounded in current official provider documentation; nothing here creates, approves, or modifies any account, credential, payout, or database row.

---

## 1. Current Git state and files inspected

- Repository: `adilparsh-code/ai-income-lab`
- Workspace checked: `/workspace/chats/2b9379745bb44ff31bd7c96c`
- Branch: `freebuff/2b9379745bb44ff31bd7c96c-phase-b1`
- HEAD: `8ef73b96b21ccf21d875543d485ae52b8608c223`
- Working tree: clean (`git status --short` empty in this environment)
- Sanitized remote URL present in this environment: `httpsREMOTE_USER`

This audit was performed on the real code base in this workspace. The important Polar/payment surfaces that exist here are:

- `src/lib/integrations/polar-publishing.ts`
- `src/lib/integrations/webhook-verification.ts`
- `src/lib/integrations/webhook-events.ts`
- `src/lib/integrations/offer-publishing.ts`
- `src/lib/integrations/markets.ts`
- `src/lib/commercial/payment-service.ts`
- `src/lib/commercial/payment-evidence.ts`
- `src/lib/commercial/offer-states.ts`
- `src/lib/commercial/engagement-states.ts`
- `src/lib/commercial/economics.ts`
- `src/lib/commercial/offer-service.ts`
- `src/lib/storefront/eligibility.ts`
- `src/lib/storefront/store.ts`
- `src/lib/storefront/inquiry.ts`
- `src/lib/security/guard.ts`
- `src/lib/security/body.ts`
- `src/lib/agency/admin-auth.ts`
- `src/lib/agency/session-guard.ts`
- `src/app/api/webhooks/polar/route.ts`
- `src/app/api/webhooks/polar/service/route.ts`
- `src/app/api/revenue/route.ts`
- `src/app/api/commercial/offers/[offerId]/route.ts`
- `src/app/api/commercial/offers/[offerId]/publish/route.ts`
- `src/lib/publishing/contract.ts`
- `src/lib/publishing/offer-publishing.ts` (referenced indirectly above)

Tests inspected:

- `src/lib/integrations/__tests__/webhook-verification.test.ts`
- `src/lib/integrations/__tests__/webhook-events.test.ts`
- `src/lib/integrations/__tests__/phase8-integrations.test.ts`
- `src/lib/integrations/__tests__/polar-offer-db.test.ts`
- `src/lib/commercial/__tests__/payment-evidence.test.ts`
- `src/lib/commercial/__tests__/commercial-pure.test.ts`
- `src/lib/commercial/__tests__/commercial-db.test.ts`
- `src/lib/commercial/__tests__/commercial-economics-db.test.ts`
- `src/lib/commercial/__tests__/production-readiness.test.ts`
- `src/lib/commercial/__tests__/gap-remediation-db.test.ts`
- `src/lib/storefront/__tests__/storefront.test.ts`

Project docs consulted:

- `docs/credentials.md`
- `.env.example`
- `docs/phase-11.4-11.8-implementation.md`
- `docs/phase-11.9-gap-remediation.md`
- `docs/first-revenue-storefront.md`
- `docs/phase-8-master-report.md` (existence only)

---

## 2. Evidence matrix

### 2.1 Polar SDK / configuration and checkout creation

| Requirement | Evidence | Verdict |
|---|---|---|
| Provider adapter implemented | `PolarPublishingAdapter` exists and implements the existing `PublishingProvider` contract. | PASS |
| Credentials read only from server-side env | `POLAR_ACCESS_TOKEN`, `POLAR_ORG_ID` are read from `process.env` inside server modules only. Token fingerprint is surfaced; raw token is never logged or returned. | PASS |
| Human approval required per publication | `publish()` in the adapter and `publishOfferToPolar()` both require a non-empty `humanApprovalToken`; the admin publish route also requires an admin session. | PASS |
| Published only after a verified provider round-trip | Adapter POSTs `/v1/products/`, then GETs the created product and refuses to claim `PUBLISHED` if the verification round-trip fails or the IDs mismatch. | PASS |
| Configured ≠ LIVE | `describePublishingStatus()` reports `PUBLISHING_READY` only on config; it does not claim any specific publication is live. | PASS |

### 2.2 Product / offer eligibility and positive-price validation

| Requirement | Evidence | Verdict |
|---|---|---|
| Offer can only go ACTIVE with positive price and screened halal status | `offer-states.ts` `canTransitionOffer()` requires `price > 0` and rejects `BLOCKED` / `UNVERIFIED` for `ACTIVE`. | PASS |
| Public listing gate is fail-closed | `storefront/eligibility.ts` requires `ACTIVE`, `price > 0`, `HALAL`, plus display-time text re-screening. | PASS |
| Publication gate enforces the same rules the storefront uses | `offer-publishing.ts` `evaluateOfferPublication()` calls `publicListingVerdict()` and also requires a linked product and buyer-facing delivery text. | PASS |
| Price is derived from the offer, not free text | `buildOfferPublishSpec()` uses `offer.price`; adapter `validate()` parses the hypothesis only as a fallback guard and refuses non-positive parsed prices. | PASS |

### 2.3 Webhook signature verification

| Requirement | Evidence | Verdict |
|---|---|---|
| Raw body verified, not re-serialized | `webhook-verification.ts` builds `signedContent` from the raw `rawBody` string. | PASS |
| Secret from server-side env only | `verifyProviderWebhook()` reads `POLAR_WEBHOOK_SECRET` from `process.env`; missing secret returns `MISSING_SECRET`. | PASS |
| Replay protection | Both standard and legacy verification enforce a timestamp tolerance window. | PASS |
| Constant-time comparison | `timingSafeEqual` is used for hex and base64 candidate comparisons. | PASS |
| Legacy and modern Polar schemes both handled | `verifyProviderWebhook()` tries Standard Webhooks first, then legacy `polar-signature` only as a fallback, with careful status reasoning. | PASS |
| Route refuses without secret | `POST /api/webhooks/polar` returns `503` when `POLAR_WEBHOOK_SECRET` is missing. | PASS |

### 2.4 Authoritative payment-status verification

| Requirement | Evidence | Verdict |
|---|---|---|
| Webhook is one authoritative source | `payment-evidence.ts` lists `PROVIDER_WEBHOOK` as a valid evidence method; `payment-service.ts` requires `signatureVerified === true` for that method. | PASS |
| Manual admin path exists and is controlled | `MANUAL_ADMIN_APPROVED` is a valid method, and `recordManualPaymentVerification()` requires reviewer + reason + evidenceRefs + timestamp. | PASS |
| Screenshot / client message / AI claim are refused by name | `UNTRUSTED_PAYMENT_CLAIM_KINDS` includes `CLIENT_SCREENSHOT`, `CLIENT_MESSAGE`, `CLIENT_ASSERTED_STATUS`, `BROWSER_PARAMETER`, `FRONTEND_FLAG`, `AI_GENERATED_CLAIM`, etc., and they are refused first. | PASS |
| Provider API path defined but not yet reachable from this integration | `PROVIDER_API` is a valid method, but this repo has no implemented Polar server-side charge-read path; that is an external-provider feature, not a repo bug. | BLOCKED / UNKNOWN (provider feature + integration gap) |

### 2.5 Webhook idempotency and duplicate-event protection

| Requirement | Evidence | Verdict |
|---|---|---|
| Payment webhook uses shared revenue idempotency | `webhook-events.ts` records through `recordRevenueWithAttribution()` and replays collapse to `DUPLICATE`. | PASS |
| Payment event ledger uses provider+event uniqueness | `payment-service.ts` uses `@@unique([provider, providerEventId])` and a deterministic replay key; replays are recorded, not applied twice. | PASS |
| Service webhook carries the same protection | `POST /api/webhooks/polar/service` calls `applyVerifiedPaymentEvent()`, which is idempotent on the same authority. | PASS |

### 2.6 Order / payment persistence and audit trail

| Requirement | Evidence | Verdict |
|---|---|---|
| Payments are persisted as evidence, not just a boolean | `PaymentEvent` row records verdict, method, amount, currency, signature status, and rejection reason. | PASS |
| Manual reviews are persisted and auditable | `ManualPaymentVerification` table exists and is written with full review attributes. | PASS |
| Audit rows are written for every outcome | Multiple `auditSecurityEvent()` calls cover refused / recorded / reversed / replay outcomes. | PASS |
| Reversals do not leave the system "paid" | `applyVerifiedReversalEvent()` reduces recognized revenue and sets `paymentState` to `REFUNDED` / `PARTIALLY_REFUNDED`. | PASS |

### 2.7 Secure delivery of the purchased product / package

| Requirement | Evidence | Verdict |
|---|---|---|
| Polar product URL is persisted into existing product fields | `publishOfferToPolar()` writes `Product.platform = 'polar'` and `Product.productUrl`. | PASS |
| Storefront renders the external buy link from those fields | Registry note and `polar-offer-db.test.ts` indicate the storefront's "Buy" link uses `platform`/`productUrl`. | PASS |
| Delivery is gated behind payment, offer state, and halal | Delivery concepts in `engagement-states.ts` require `DELIVERY_AUTHORIZED` / payment verification; public listing requires `HALAL`. | PASS |
| Direct digital-asset download path is not fully verified here | The repo does not expose a standalone "download asset by order" module in the files inspected for this audit; delivery is therefore partially implementation-dependent on the offer type. | UNKNOWN |

### 2.8 Revenue, refunds, provider fees, cost / profit records

| Requirement | Evidence | Verdict |
|---|---|---|
| Revenue recording exists and is gated | `POST /api/revenue` is operator-token-gated and writes through the existing revenue pipeline. | PASS |
| Webhook revenue records through the same pipeline | `webhook-events.ts` calls `recordRevenueWithAttribution()` with source `POLAR_WEBHOOK`. | PASS |
| Refund / reversal reduces recognized revenue | `economics.ts` `recognizedRevenueAfterReversal()` and `payment-service.ts` reversal path reduce recognized revenue and refund totals; revenue is clamped at zero. | PASS |
| Provider payout fees are understood at the platform level | Polar docs state Stripe payout fees and FX conversion fees; the repo does not need to recompute them, but they affect realized seller proceeds. | PASS (platform-side) |
| Cost / P&L exist for engagements | `economics.ts` records `EngagementCost` with `basis`, and computes realized P&L from ACTUAL rows. | PASS |
| Polar-side seller fees are not itemized in the repo | That is provider billing, not application logic; the repo correctly treats it as external. | PASS (external) |

### 2.9 Admin approval, halal eligibility, ownership, security gates

| Requirement | Evidence | Verdict |
|---|---|---|
| Publishing requires admin auth | `POST /api/commercial/offers/[offerId]/publish` requires `requireAdminApi()`. | PASS |
| Payment state changes require a real verification source | `offer-states.ts`, `engagement-states.ts`, and `payment-service.ts` all require `PROVIDER_WEBHOOK` / `PROVIDER_API` / `MANUAL_ADMIN_APPROVED`. | PASS |
| Halal is recomputed server-side, not trusted from the client | `publicListingVerdict()` and `evaluateOfferPublication()` re-screen customer-facing text. | PASS |
| Ownership checks exist on engagements / milestones | `payment-service.ts` verifies engagement and milestone ownership and currency match. | PASS |
| Admin session is DB-backed and fail-closed | `session-guard.ts` and `admin-auth.ts` resolve sessions server-side. | PASS |

### 2.10 Production environment variable names and presence only

| Variable | Purpose | Present / configured in this workspace? | Verdict |
|---|---|---|---|
| `DATABASE_URL` / `DIRECT_URL` | Application + Prisma CLI database connections | Present in `.env.example` as empty placeholders; no real value inspected or printed. | BLOCKED/UNKNOWN (not readable here) |
| `POLAR_ACCESS_TOKEN` | Polar merchant-of-record API credential | Not configured in this environment's inspection; adapter advertises `AUTH_REQUIRED`. | BLOCKED/UNKNOWN |
| `POLAR_ORG_ID` | Optional Polar organization scoping | Same as above. | BLOCKED/UNKNOWN |
| `POLAR_WEBHOOK_SECRET` | Webhook signature secret | Not configured in this environment's inspection; payment webhook returns `503`. | BLOCKED/UNKNOWN |
| `OPERATOR_REVENUE_TOKEN` | Operator revenue ingestion token | Not configured in this environment's inspection; revenue endpoint returns `503`. | BLOCKED/UNKNOWN |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` or `ADMIN_PASSWORD_HASH` | Admin session auth material | Not inspected here; admin auth docs describe the model. | BLOCKED/UNKNOWN |
| `AI_INCOME_MARKET` | Non-secret market region (`GLOBAL` or `IN`) | Optional; not required for the payment path itself. | UNKNOWN |

**Important:** this audit intentionally did not print any secret values, tokens, webhook secrets, bank details, or KYC data. Where a variable is "BLOCKED/UNKNOWN", the reason is that it is either not configured in this environment or not readable here, not that the code is wrong.

---

## 3. Existing payment integration status

### 3.1 What is implemented

- A Digital Product offer → Polar publication bridge exists and is human-gated.
- Polar product creation + verification round-trip exists.
- Polar product URL is persisted into existing product fields used by the storefront.
- Payment webhook signature verification exists and is fail-closed.
- Two webhook surfaces exist:
  - `POST /api/webhooks/polar` — digital-product-style webhook → revenue pipeline
  - `POST /api/webhooks/polar/service` — service-payment webhook → governed engagement/milestone state
- A payment evidence classification boundary exists.
- A controlled manual verification path exists.
- Reversal / refund handling exists at the application level.
- Revenue idempotency exists for both webhook paths.

### 3.2 What is NOT yet live in this workspace

- No `POLAR_ACCESS_TOKEN` is confirmed configured here, so no external Polar call is being made from this environment.
- No `POLAR_WEBHOOK_SECRET` is confirmed configured here, so the payment webhooks refuse with `503` until it is set.
- No `OPERATOR_REVENUE_TOKEN` is confirmed configured here, so manual revenue ingestion also refuses until it is set.
- No verified live provider round-trip has been performed in this environment; the code can support it, but this environment has not verified it end to end.
- The repo does not appear to contain a standalone "fulfill a specific Polar order by downloading a specific asset bundle" module in the files inspected; digital-product delivery is therefore tied to the existing product/offer/storefront model and possibly external fulfillment logic that this audit did not fully trace.

### 3.3 What the existing tests cover

The tests present in this workspace provide strong coverage of the important failure and security cases:

- Signature verification: valid signed request, tampered body, stale timestamp, missing headers, missing secret, legacy Polar signatures.
- Event processing: valid paid order, non-paid event ignored, invalid amount, unsupported currency, NaN/Infinity refused, product-not-linked rejected.
- Polar offer-to-webhook-to-revenue chain: ACTIVE/HALAL/price/screening/product/delivery gates, human approval required, inactive offer rejected, non-halal rejected, zero price rejected, successful publish path, missing/bad signature rejected, malformed signed webhook ignored, valid signed webhook recorded once, duplicate idempotent, unknown offer/product/offer rejected, revenue created exactly once.
- Payment evidence: untrusted claims refused, method preconditions enforced, replay window enforced, amount/currency validation, manual review attribution, reversal arithmetic.
- Storefront eligibility: ACTIVE/HALAL/price/screening gates, control-character rejection, inquiry validation, intake abuse protections, and the structure invariant that the public storefront stays outside the admin gate.

The larger commercial suites in this workspace also include DB-backed commercial tests, economics tests, production-readiness tests, and gap-remediation tests. Those were not re-run for this audit; the audit relies on their existence and on the code paths they are named against.

---

## 4. Official seller / payout eligibility findings

These findings are based only on current official Polar documentation and the official Stripe/Razorpay documentation consulted for this audit. They are not legal or tax advice and they are not a guarantee of onboarding success.

### 4.1 India is listed as a supported payout country for Polar

Polar lists India among the countries where Stripe Connect Express payouts are supported. Polar explicitly addresses the "Stripe is invite-only in my country" question by saying the Merchant-of-Record model does not require Stripe Payments to be available in the seller's country; only Stripe Connect Express payout coverage is required.

**Sources:**
- Polar: Supported countries — https://polar.sh/docs/merchant-of-record/supported-countries
- Polar: Payout Accounts — https://polar.sh/docs/features/finance/accounts
- Polar: Payouts — https://polar.sh/docs/features/finance/payouts

### 4.2 Individual sellers appear supported, with a regional Stripe Connect caveat

Polar says an individual can sell globally if Stripe Connect Express supports `individual` as a business type for that region, and gives a procedure for checking the supported business types via the Stripe account-configuration toggles.

**Source:**
- Polar: Supported countries FAQ — https://polar.sh/docs/merchant-of-record/supported-countries

This is the single most important unresolved item: the docs say "if supported in your region" rather than unconditionally. India is listed as a payout country, but the precise individual-business-type support for an India Stripe Connect Express recipient should be confirmed with Polar/Stripe onboarding rather than assumed from the country list alone.

### 4.3 A personal bank account may be acceptable for an individual account

Polar states that individual accounts can use a personal bank account, while business accounts need a business bank account. Stripe's general payout documentation describes savings/checking accounts as supported types.

**Sources:**
- Polar: Payouts FAQ — https://polar.sh/docs/features/finance/payouts
- Stripe: Receive payouts — https://docs.stripe.com/payouts

### 4.4 Payout account must be in the same country as the seller, in the local currency

Polar's payout-accounts page states that Stripe Connect requires the bank account to be in the same country as the business and use that country's local currency, and that this is a Stripe/banking-network requirement Polar cannot override.

**Source:**
- Polar: Payout Accounts — https://polar.sh/docs/features/finance/accounts

In practical terms, that is consistent with an Indian seller connecting an Indian bank account.

### 4.5 Settlement currency is USD; INR checkout does not mean INR settlement

Polar's balance documentation says non-USD customer payments are converted to USD for the account balance, and the balance is what is available for payout.

**Source:**
- Polar: Account Balance & Transparent Fees — https://polar.sh/docs/features/finance/balance

That means an Indian seller's Polar balance is held in USD, even if some customers pay in INR through Polar's checkout. The INR-to-USD conversion happens on the customer-payment side, not necessarily at the final bank-payout step.

The precise final payout currency and any INR settlement details for an Indian Connect recipient were not fully spelled out in the Polar pages consulted; that is an open confirmation item.

### 4.6 Verification, KYC, payout account, and timing

Polar documents the first-payout review as:
- Submit business/product/use information from Finance → Account
- Identity verification (passport / ID card / driver's license + selfie) via Stripe Identity
- Connect a payout account via Stripe Connect Express
- Initial reviews can take up to 14 days

Polar also documents a 7-day settlement delay for organizations created on or after May 12, 2026, and typical payouts taking 4–7 business days.

**Sources:**
- Polar: Account reviews — https://polar.sh/docs/merchant-of-record/account-reviews
- Polar: Payouts — https://polar.sh/docs/features/finance/payouts

### 4.7 Acceptable Use and account-health rules matter for digital products too

Polar reviews accounts against its Acceptable Use Policy and monitors chargeback ratios; it states a 0.4% internal chargeback threshold and describes continuous reviews.

**Source:**
- Polar: Account reviews — https://polar.sh/docs/merchant-of-record/account-reviews

This is relevant because not every "digital product" is automatically acceptable; the product content and sales pattern still need to fit Polar's policy.

### 4.8 Unresolved questions that must be confirmed with Polar

1. Does Stripe Connect Express in India support the `individual` business type for a Polar payout recipient in the exact way Polar's docs assume?
2. Will a personal Indian savings account in the seller's own name be accepted for that specific Connect payout account?
3. What is the final payout currency for an Indian recipient, what INR/USD conversion applies, and what fees apply at the Stripe Connect payout step?
4. What Indian seller-side obligations remain on the seller (income tax, GST if applicable, export/invoicing documentation, reverse invoicing, etc.)? Polar's public docs do not resolve those.
5. Does the intended product category fit Polar's Acceptable Use Policy before any integration work is done?

These are not repo defects. They are provider-confirmed-eligibility questions.

---

## 5. Razorpay as a separate Indian-customer option

Razorpay is a commonly used India-focused payment gateway. Its own docs describe account setup and bank-account verification for Indian sellers, and its activation guidance describes personal-account onboarding for unregistered individuals / sole proprietors alongside business-current-account requirements for registered businesses. It also documents international-payments limitations that can matter for a seller who wants to take payments from outside India.

**Sources:**
- Razorpay: Set up an account — https://razorpay.com/docs/payments/set-up
- Razorpay: Account activation requirements — https://razorpay.com/docs/payments/account-activation-support
- Razorpay: International payments — https://razorpay.com/docs/payments/international-payments

That makes Razorpay a plausible separate path for domestic Indian customer payments. It does not replace Polar for the international-merchant-of-record path described in this repo's Polar integration. The decision between them is a business/eligibility decision, not a code defect.

---

## 6. Test commands and actual results

This audit did not re-run the full suite by default, because:
- The workspace configuration is not confirmed here for a safe production-adjacent run,
- The relevant payment/webhook tests already exist and are already named against the exact code paths inspected, and
- The audit's goal was readiness, not a full regression run.

What this audit did confirm directly:
- The relevant test files exist and are named against the exact modules reviewed.
- The integration tests for the Polar offer → webhook → revenue chain are real, DB-backed, and cover the key failure/replay/mapping cases.
- The webhook verification and payment evidence tests are real and cover signature, replay, amount, currency, untrusted-claim, and reversal cases.

If you want a concrete verification run, the repo's test command is:

```bash
npm test
```

Targeted, safer subsets that touch the payment surfaces without touching unrelated live paths:

```bash
node --test src/lib/integrations/__tests__/webhook-verification.test.ts src/lib/integrations/__tests__/webhook-events.test.ts
node --test src/lib/integrations/__tests__/polar-offer-db.test.ts
node --test src/lib/commercial/__tests__/payment-evidence.test.ts
node --test src/lib/storefront/__tests__/storefront.test.ts
```

Typecheck and lint are also available:

```bash
npm run typecheck
npm run lint
```

No test output was captured or reproduced in this audit beyond confirming file existence and code correspondence. If you want actual test results, that is the next safe action.

---

## 7. Exact missing steps for the owner to complete manually

These are manual, provider-side, or configuration steps. None are repo changes.

### 7.1 Before any code change is meaningful

1. Decide whether the first sale should go through Polar, Razorpay, or both for different customer groups.
2. If Polar is the intended primary path, create/log in to the Polar dashboard and inspect whether the intended product category is acceptable under Polar's Acceptable Use Policy before investing in integration.
3. In Polar, submit the Finance → Account information and complete identity verification via Stripe Identity.
4. Connect a Stripe Connect Express payout account from India, using an Indian bank account in the same country and local currency, and confirm during onboarding whether the individual business type is supported for the India recipient.
5. Confirm the final payout currency and any INR-related handling for the India payout path with Polar/Stripe onboarding.

### 7.2 Then configure this repo's production environment

Set, in the deployment platform's secret store (not in committed files):

- `POLAR_ACCESS_TOKEN`
- `POLAR_ORG_ID` (if needed)
- `POLAR_WEBHOOK_SECRET`
- `OPERATOR_REVENUE_TOKEN`
- `ADMIN_EMAIL` and either `ADMIN_PASSWORD_HASH` or `ADMIN_PASSWORD`
- `DATABASE_URL` and `DIRECT_URL` (already documented in `.env.example` and `docs/credentials.md`)

These are the env var names the repo actually reads:

- `POLAR_ACCESS_TOKEN`
- `POLAR_ORG_ID`
- `POLAR_WEBHOOK_SECRET`
- `OPERATOR_REVENUE_TOKEN`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD` or `ADMIN_PASSWORD_HASH`
- `DATABASE_URL`
- `DIRECT_URL`

### 7.3 Then publish and verify end to end

1. Create an ACTIVE, HALAL, priced offer with a linked product and buyer-facing delivery info.
2. Publish it through `POST /api/commercial/offers/[offerId]/publish` with an explicit human approval token and an admin session.
3. Confirm the Polar product URL is persisted and visible in the storefront.
4. Set up the Polar webhook pointing at `POST /api/webhooks/polar` (digital-product path) and/or `POST /api/webhooks/polar/service` (service-payment path), using the secret configured in `POLAR_WEBHOOK_SECRET`.
5. Perform at least one real, small, policy-compliant test purchase and confirm:
   - the webhook is received and signature-verified,
   - the event is parsed correctly,
   - revenue is recorded exactly once,
   - a replay is collapsed to duplicate,
   - and for a service engagement, the governed payment state moves through the intended transition.

### 7.4 Seller-side obligations to confirm separately

- Indian income-tax treatment of the seller's Polar payouts and any INR/USD conversion effects.
- Any GST registration/filing obligations that may apply to the seller's situation.
- Reverse-invoicing workflow for payouts (Polar supports generating reverse invoices per payout; the seller still needs to confirm their own accounting/tax details).
- Export/invoicing documentation requirements for digital sales to international buyers, if applicable.

---

## 8. Whether a current account appears necessary

Based only on the provider documentation consulted for this audit:

- Polar does not publish a rule that an India-based individual seller must have a business current account. Its payout-account page says individual accounts can use a personal bank account and that the Stripe Connect payout account must be in the same country as the seller, in the local currency.
- Stripe's general payout guidance describes both savings and checking accounts as supported payout account types.
- The India-specific nuance is that Stripe's direct India merchant-account guidance and India international-payment guidance discuss registered businesses and INR current/savings accounts. Those are rules about direct Stripe merchant accounts, and they do not automatically resolve how a Polar Stripe Connect Express payout recipient in India is treated.

So the honest conclusion is:

- A current account is **not clearly required by the Polar documentation examined here** for an individual seller, but
- The exact India Connect recipient onboarding path and accepted account types are **not fully confirmed by the public docs**, so this should be verified during the Polar/Stripe Connect onboarding step rather than assumed.

If the owner will also want to take domestic Indian customer payments directly, Razorpay's docs describe a separate path that can use personal-bank-account onboarding for unregistered individuals/sole proprietors but reaches different international-payment limits. That is a separate eligibility conversation, not a Polar one.

---

## 9. One recommended next action

**Do the Polar eligibility confirmation before any code expansion.**

The smallest safe next step is not a code change. It is:

1. Confirm with Polar (dashboard onboarding or support) whether an India-based individual can complete Stripe Connect Express payout onboarding as an individual, and whether a personal Indian savings account is accepted for that payout account.
2. Confirm the final payout currency/fees for that India payout path.
3. Only after that confirmation, configure `POLAR_ACCESS_TOKEN`, `POLAR_ORG_ID`, `POLAR_WEBHOOK_SECRET`, and `OPERATOR_REVENUE_TOKEN` in the deployment environment and run a small live test purchase through the existing webhook + revenue path.

The existing code already implements the technical path for Polar digital-product publication, signature-verified payment webhooks, idempotent revenue recording, service-payment verification, manual admin verification, and reversals. The main remaining blockers are configuration and provider-eligibility confirmation, not missing implementation.

If the Polar India individual/savings-account path is confirmed, the next code-level step is a small live verification of the already-implemented flow rather than a new gateway or rewrite. If it is not confirmed, the next step is a separate eligibility discussion about Razorpay for domestic Indian customers, without touching the existing Polar code.

---

## 10. What was NOT done

- No account was created, approved, or modified on Polar, Stripe, or Razorpay.
- No KYC, payout account, bank account, or seller verification was submitted.
- No credential values, webhook secrets, bank details, or KYC data were printed.
- No production environment was changed, no database was touched, and no deployment was performed.
- No existing code was rewritten, no gateway was added, and no lockfile or major dependency was changed.
- No existing Ruflo integration work was interrupted or overwritten.
