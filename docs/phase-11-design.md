# AI INCOME LAB — PHASE 11.0 DESIGN (FINAL, COMPLETE)

## CLIENT + SERVICE INCOME ARCHITECTURE — READ-ONLY DESIGN / NO IMPLEMENTATION

**Status**: finalized read-only design produced from the Phase 10A master audit of the actual repository (42-model Prisma schema, governance chain, Job Runner, webhook verification stack, Phase 10 Observatory, Phase 10A Control Center). Nothing in this document has been implemented: no schema changes, no migration, no provider installed or connected, no adapter fabricated. Freebuff remains NOT_CONNECTED / NOT_IMPLEMENTED (verified from source, not assumed).

---

## 1. Mission & desired future loop

Extend AIL from a digital-product income system into a **governed professional client/service income operating system** — one job system, one halal filter, one audit spine, one revenue ledger:

```
DISCOVER PROSPECT → QUALIFY → CONTACT → CONVERSATION → REQUIREMENTS
→ PROPOSAL → CLIENT COMMITMENT → PAYMENT PROTECTION → SERVICE JOB
→ EXECUTION → QA → DELIVERY → CLIENT ACCEPTANCE → FINAL PAYMENT
→ REVENUE → COST → PROFIT/LOSS → LEARNING → IMPROVEMENT → NEXT CLIENT
```

**Seven hard architectural invariants** (enforced in code, not policy):

1. **No verified payment → no authorized work** (low-risk exceptions only via explicit admin config, OFF by default).
2. **Client messages are DATA, never AUTHORITY** — they cannot alter permissions, budgets, halal state, governance, or payment state.
3. **Payment truth only from provider webhook / provider API / admin-approved manual verification** — never screenshots, claims, receipts, or messages.
4. **Proposals immutable once approved** — changes create new versions.
5. **Scope and revisions finite by contract** — overrun ⇒ paid change flow.
6. **Client content sandboxed like fetched web content** — provenance-labelled, injection-quarantined.
7. **Irreversible, financial, and legal decisions are human-only.**

Service categories (websites, landing pages, email templates, automation, bots, documentation, spreadsheets, reports, research, educational materials, software/tools, design, content/copy, other legitimate services) share **reusable primitives** — no per-category architecture: one `ServiceExecutionProvider` abstraction + category-as-data payload + deliverable kinds + QA gates (§17–18).

## 2. Data model — smallest normalized set

### 2.1 Reuse first (no changes to existing tables)

- `Opportunity` (service rows via `businessModel: 'CLIENT_SERVICE'`)
- `EvidenceItemModel` (provenance for discovery, requirements, acceptance evidence)
- `JobRun` / `AgentRun` / `AgentDefinition` / `AgentPermission` / `AgentHealth` / `AgentMessage` (same runner + Phase 10A control)
- `HumanReview` (`category` is a String column → new code-level categories: `OUTREACH`, `PROPOSAL_SEND`, `REFUND`, `LEGAL_DISPUTE`, `CONTRACT_TERMINATION`, `MANUAL_PAYMENT_VERIFICATION`, `HIGH_VALUE_CONTRACT`)
- `SecurityEvent` / `RateLimitWindow` (abuse/injection audits, per-conversation limits)
- `IntegrationAuthorization` (provider credentials/state)
- `Revenue` (service income via `opportunityId` + unique `idempotencyKey`; future additive nullable `serviceEngagementId` / `milestoneId`)
- `LearningEntry` / `OperationalMemory` / `FailureRecord` / `AgentLog` (learning + execution logs)

**Folded (no separate tables)**: `Client` → `Prospect.lifecycleState`; `Contact` → Prospect fields; `ClientRiskProfile` → Prospect risk fields; `ScopeItem` → JSON in immutable `ProposalVersion`; `ClientApproval` → structured evidence on ProposalVersion/Milestone/Deliverable; `Revision` → deliverable state cycles + counters (paid change ⇒ new ProposalVersion); `PaymentRequirement` → Milestone payment fields. Result: **9 new tables instead of ~20**, preserving auditability, state transitions, financial linkage, security, scalability, idempotency.

### 2.2 Proposed new models (conceptual; migration 0008 later, additive-only)

```prisma
model Prospect {
  id String @id @default(cuid())
  lifecycleState String @default("NEW")   // NEW UNVERIFIED QUALIFIED CONTACTED CLIENT LOST BLOCKED
  riskState      String @default("NEW")   // NEW UNVERIFIED LOW_RISK NORMAL REVIEW_REQUIRED PAYMENT_REQUIRED PAYMENT_VERIFIED HIGH_RISK BLOCKED
  displayName String; email String?; emailDomain String?; website String?   // business-level only (PII minimization)
  businessInfo String @default("{}")        // bounded JSON
  source String                             // DISCOVERY_PROVIDER | INBOUND | REFERRAL | MANUAL
  sourceProvider String?; sourceRef String?; evidenceRefs String @default("[]")
  acceptedCount Int @default(0); paidCount Int @default(0); failedPaymentCount Int @default(0)
  disputeCount Int @default(0); chargebackCount Int @default(0); cancellationCount Int @default(0)
  scopeChanges Int @default(0); revisionOverruns Int @default(0); abuseFlags Int @default(0); injectionFlags Int @default(0)
  resourceWasteFlags Int @default(0); historyTamperFlags Int @default(0)
  lifetimePaidUsd Float @default(0); lastRiskEvaluatedAt DateTime?
  optedOut Boolean @default(false); optedOutAt DateTime?; lastContactedAt DateTime?
  contactAttempts Int @default(0); suppressionReason String?
  createdAt; updatedAt
  @@unique([email])  @@index([lifecycleState]) @@index([riskState]) @@index([optedOut])
}

model Conversation {
  id String @id; prospectId String; channel String            // EMAIL | PORTAL | API
  state String @default("OPEN")        // OPEN REQUIREMENTS_READY PROPOSAL_PENDING CLOSED_BLOCKED CLOSED_LOST CLOSED_COMPLETED
  injectionFlagCount Int @default(0); prospectMessageCount Int @default(0)
  createdAt; updatedAt; @@index([prospectId, state])
}

model Message {
  id String @id; conversationId String
  direction String                     // INBOUND | OUTBOUND_INTERNAL | OUTBOUND_CLIENT
  role String                          // CLIENT | SYSTEM_DRAFT | AGENT | ADMIN
  body String                          // bounded <=10k chars; NO attachments in 11.x
  providerMessageId String?; providerStatus String?   // SENT DELIVERED BOUNCED COMPLAINED FAILED
  trustFlags String @default("[]")     // PROMPT_INJECTION_SUSPECTED | CREDENTIAL_REQUEST | PAYMENT_CLAIM | FREE_WORK_REQUEST | URGENCY_PRESSURE | HISTORY_TAMPER_ATTEMPT | RESOURCE_WASTE
  treatedAs String @default("DATA"); immutable Boolean @default(true)
  createdAt; @@unique([channel, providerMessageId]) @@index([conversationId, createdAt])
}

model Proposal {
  id String @id; prospectId String; opportunityId String?
  serviceCategory String               // WEBSITE | LANDING_PAGE | EMAIL_TEMPLATE | AUTOMATION | BOT | DOCUMENTATION | SPREADSHEET | REPORT | RESEARCH | EDUCATIONAL | SOFTWARE_TOOL | DESIGN | CONTENT_COPY | OTHER_LEGITIMATE
  currentVersion Int @default(0); approvedVersion Int?        // set ONLY with acceptance evidence
  state String @default("DRAFT")       // DRAFT INTERNAL_REVIEW SENT ACCEPTED DECLINED EXPIRED SUPERSEDED
  halalStatus String                   // existing screenForHalalCompliance — gate before ANY send
  createdAt; updatedAt; @@index([prospectId, state])
}

model ProposalVersion {                // append-only (AgentConfigVersion precedent)
  id String @id; proposalId String; version Int
  scopeItems String @default("[]"); exclusions String @default("[]"); timeline String
  revisionLimit Int @default(2); revisionRoundsUsed Int @default(0)
  price Float; currency String @default("USD")
  paymentModel String                  // UPFRONT_100 | DEPOSIT_50 | MILESTONES | PILOT_PAID
  paymentSchedule String @default("[]")// JSON [{milestoneKey, percent, trigger}]
  acceptanceMechanism String           // EXPLICIT_MESSAGE | SIGNED_DOCUMENT | SILENCE_WINDOW(*)
  expiresAt DateTime?; cancellationPolicy String
  identityDisclosure String            // truthful "AI-assisted service team"
  clientApprovalEvidence String?; approvedAt DateTime?; changedBy String; reason String?
  createdAt; @@unique([proposalId, version]) @@index([proposalId, createdAt])
}

model ServiceEngagement {
  id String @id; prospectId; proposalId; proposalVersion Int; opportunityId String?
  paymentGateState String @default("NO_COMMITMENT")
  // NO_COMMITMENT PROPOSAL_SENT ACCEPTED PAYMENT_REQUIRED PAYMENT_PENDING PAYMENT_VERIFIED
  // WORK_AUTHORIZED WORK_IN_PROGRESS DELIVERABLE_READY FINAL_PAYMENT_REQUIRED
  // DELIVERY_AUTHORIZED COMPLETED PAUSED TERMINATED CANCELLED
  exposureCapUsd Float @default(0)     // hard bound on authorized unpaid internal cost
  workAuthorizedAt DateTime?; completedAt DateTime?
  createdAt; updatedAt; @@index([paymentGateState]) @@index([opportunityId])
}

model Milestone {
  id String @id; engagementId String; key String; title String
  percent Int; amountUsd Float; currency String
  paymentState String @default("NOT_DUE")   // NOT_DUE PAYMENT_REQUIRED PAYMENT_PENDING PAYMENT_VERIFIED REFUNDED PARTIALLY_REFUNDED
  verificationSource String?           // PROVIDER_WEBHOOK | PROVIDER_API | MANUAL_ADMIN_APPROVED — never client-asserted
  providerRef String?; acceptanceEvidence String?; acceptedAt DateTime?
  @@unique([engagementId, key]) @@index([paymentState])
}

model Deliverable {
  id String @id; engagementId String; milestoneKey String?
  title String; kind String
  state String @default("DRAFT")       // DRAFT QA_PENDING QA_PASSED READY_FOR_DELIVERY DELIVERED CLIENT_REVIEW ACCEPTED REVISION_REQUESTED REVISION_LIMIT_REACHED COMPLETED WITHHELD
  isPreview Boolean @default(false)    // PREVIEW vs FINAL_DELIVERABLE
  artifactRefs String @default("[]")   // bounded; no secrets, no credentials — ever
  revisionCount Int @default(0); revisionLimit Int
  deliveredAt DateTime?; acceptedAt DateTime?; acceptanceEvidence String?
  createdAt; updatedAt; @@index([engagementId, state])
}

model ServiceIssue {                   // disputes/cancellations/refunds — one table
  id String @id; engagementId String
  issueType String   // CANCELLATION_REQUESTED CANCELLATION_APPROVED DISPUTE CHARGEBACK REFUND_REQUESTED REFUND_PROCESSED PAUSED TERMINATED
  status String @default("OPEN")       // OPEN APPROVED REJECTED RESOLVED PROCESSED
  evidenceRefs String @default("[]")   // full conversation + delivery history preserved
  requiresHuman Boolean @default(true); decidedBy String?; decidedAt DateTime?
  resolutionNote String?; correlationId String
  createdAt; updatedAt; @@index([engagementId]) @@index([issueType, status])
}
```

Idempotency/replay: `Prospect.email` unique; `Message(channel, providerMessageId)` unique; `ProposalVersion(proposalId, version)` unique; `Milestone(engagementId, key)` unique; all money additionally flows through `Revenue.idempotencyKey`.

## 3. State machines (actors: **A**dmin, **S**ystem/agent, **C**lient, **P**rovider webhook)

1. **Prospect**: NEW →(S, evidence)→ QUALIFIED →(A, outreach approval)→ CONTACTED →(S)→ CLIENT; any →(A/rules)→ LOST; any →(A only)→ BLOCKED. Forbidden: NEW→CONTACTED; CLIENT→PROSPECT without A.
2. **Conversation**: OPEN →(S)→ REQUIREMENTS_READY →(S)→ PROPOSAL_PENDING →(S/A)→ CLOSED_{COMPLETED|LOST|BLOCKED}. Forbidden: reopening (new conversation instead; history immutable).
3. **Proposal**: DRAFT →(A)→ INTERNAL_REVIEW →(A)→ SENT →(C evidence)→ ACCEPTED | DECLINED; SENT →(timeout)→ EXPIRED; change ⇒ SUPERSEDED + new version. Forbidden: SENT→ACCEPTED without evidence; editing approved versions.
4. **Payment (per Milestone)**: NOT_DUE →(S)→ PAYMENT_REQUIRED →(C)→ PAYMENT_PENDING →(**P or A-with-review only**)→ PAYMENT_VERIFIED →(A)→ REFUNDED/PARTIALLY_REFUNDED. Forbidden: verification by anything else; client claims never transition this machine.
5. **ServiceEngagement**: NO_COMMITMENT → PROPOSAL_SENT → ACCEPTED → PAYMENT_REQUIRED → PAYMENT_VERIFIED → WORK_AUTHORIZED → WORK_IN_PROGRESS → DELIVERABLE_READY → FINAL_PAYMENT_REQUIRED → PAYMENT_VERIFIED → DELIVERY_AUTHORIZED → COMPLETED; PAUSED/TERMINATED/CANCELLED A-only. Forbidden: skipping PAYMENT_VERIFIED before WORK_AUTHORIZED.
6. **Milestone**: NOT_DUE → payment machine (4) + acceptance (9); milestone-N verification gates milestone-N+1 work.
7. **Deliverable**: DRAFT → QA_PENDING → QA_PASSED → READY_FOR_DELIVERY →(A/policy)→ DELIVERED → CLIENT_REVIEW → ACCEPTED | REVISION_REQUESTED →(count<limit)→ QA_PENDING | REVISION_LIMIT_REACHED →(paid change)→ resume; WITHHELD. Forbidden: DRAFT→DELIVERED; WITHHELD→DELIVERED without gate.
8. **Revision**: cycles within Deliverable; over limit ⇒ estimate → charge → authorization → resume. Forbidden: silent continuation.
9. **ClientAcceptance**: an **evidence record** `{type: PROVIDER_PAYMENT | EXPLICIT_CLIENT_MESSAGE | SIGNED_DOCUMENT | MILESTONE_ACCEPTANCE | ADMIN_VERIFIED, ref, acceptedAt, reviewedBy?}` on ProposalVersion/Milestone/Deliverable. Silence ⇒ NOT accepted unless an admin-activated, legally-reviewed silence-window policy exists (OFF by default).
10. **Dispute (ServiceIssue)**: OPEN →(A)→ APPROVED/REJECTED → RESOLVED/PROCESSED; CHARGEBACK human-only; AI drafts only.

## 4. Payment protection principle & configurable policy

Default chain makes unpaid work **structurally impossible**: `WORK_AUTHORIZED` reachable only from `PAYMENT_VERIFIED`, enforced as a dispatch precondition in the service path (same style as existing halal/budget gates). `exposureCapUsd` bounds internal cost inside authorized work; per-agent contract budgets apply as today.

Configurable `paymentModel` per proposal (admin-approved): **UPFRONT_100** (small: pay → work → deliver), **DEPOSIT_50** (medium: deposit → milestone 1 → approval → milestone 2 → final), **MILESTONES** (large: deposit → A → B → final acceptance → balance), **PILOT_PAID** (paid bounded sample, creditable). Policy thresholds live as admin-configured constants (the Phase 10A pattern generalizes); the anti-pattern *request → unlimited work → deliver → invoice afterward* is never a default path — work-before-payment exists only as an explicit per-client, low-risk admin exception (`riskState ∈ {PAYMENT_VERIFIED, LOW_RISK}` + exposureCap; SecurityEvent-logged).

## 5. Payment verification — hard invariant

`verificationSource ∈ {PROVIDER_WEBHOOK, PROVIDER_API, MANUAL_ADMIN_APPROVED}` only. Reuses `verifyStandardWebhook` / `verifyLegacyPolarWebhook` (timing-safe HMAC, ±5-min replay window) and Polar adapter API checks; the manual path **creates `HumanReview(MANUAL_PAYMENT_VERIFICATION)`** — the admin's evidence-backed decision is the recorded cause. Screenshots, "payment sent" messages, email claims, and uploaded receipts **cannot mutate payment state** — they only set a `PAYMENT_CLAIM` trust flag and optionally open a review task; fake claims increment `abuseFlags`.

## 6. Deterministic, explainable risk model

Explicit states: `NEW UNVERIFIED LOW_RISK NORMAL REVIEW_REQUIRED PAYMENT_REQUIRED PAYMENT_VERIFIED HIGH_RISK BLOCKED`. Rules over Prospect counters (thresholds admin-configurable):

- NEW / UNVERIFIED — default / identity-minimal
- NORMAL — identity complete + clean counters
- LOW_RISK — ≥1 accepted+paid engagement, zero disputes
- REVIEW_REQUIRED — failedPayment>0 ∨ cancellations≥2 ∨ scopeChanges≥2 ∨ revisionOverruns≥1 ∨ abuseFlags≥1 ∨ injectionFlags≥1 ∨ high-value above threshold
- PAYMENT_REQUIRED — policy default for NEW/UNVERIFIED pre-work
- PAYMENT_VERIFIED — §5 sources only
- HIGH_RISK — chargeback>0 ∨ disputes≥2 ∨ injectionFlags≥2 ∨ historyTamperFlags≥2 ∨ resourceWasteFlags≥3 ∨ repeated unpaid deliveries
- BLOCKED — admin-only (auto-proposed by rules)

**If a numeric score is ever added**: inputs = the counters; weights fixed and published in code; explicit thresholds; **limitations** — counters are gameable by patient adversaries, so a score can never unlock payment gates (only `verificationSource` can); **false-positive posture** — uncertain clients get friction (PAYMENT_REQUIRED), never auto-rejection or auto-trust.

## 7. Risk protection matrix

| Client Risk | Detection | System Response | Human Review? | Financial Protection |
|---|---|---|---|---|
| Fake payment claim | `PAYMENT_CLAIM` flag; no provider event | No state change; review task; audit | Only via manual path | Work stays unauthorized/withheld |
| Fraudulent payment claims / chargeback | ServiceIssue CHARGEBACK (webhook/policy) | Pause; freeze deliverables | **Required** | exposureCap bounds loss; evidence preserved |
| Unpaid delivery ("take work, refuse payment") | Gate checks | Preview-only until final payment verified | No (rule) | FINAL_PAYMENT_REQUIRED gate |
| Large unpaid work before commitment | proposal/payment gate | Proposal/payment required before tasks | No (rule) | No WORK_AUTHORIZED path |
| Scope creep / repeated unpaid scope changes | Scope classifier → `SCOPE_CHANGE_REQUEST`; scopeChanges counter | Estimate → revised quote → approval+payment | Large changes only | No silent expansion |
| Excessive revisions / indefinite revision exploitation | revisionCount vs limit | REVISION_LIMIT_REACHED → paid change | Optional | No unpaid rounds |
| Free work / unpaid "test projects" | `FREE_WORK_REQUEST` classifier | Paid pilot / bounded PoC / watermarked sample / refuse | Context-dependent | Bounded sample only |
| Credentials/files before payment | CREDENTIAL_REQUEST pattern | REFUSE + SecurityEvent + abuseFlags | A informed | Secrets never in artifactRefs |
| Pressure to bypass payment gates | Gate-precondition refusals (explicit, audited) | REFUSED + SecurityEvent | A informed | Gates are code, not negotiable |
| Suspicious identity | domain/email mismatch, thin business info | UNVERIFIED → payment-first | Optional | Deposit required |
| Suspicious urgency | URGENCY_PRESSURE flag + deadline anomalies | Gates unchanged; flag | Optional | No bypass, ever |
| Repeated cancellations | cancellationCount | REVIEW_REQUIRED | Yes at ≥2 | Deposit required |
| Repeated failed payments | failedPaymentCount | REVIEW_REQUIRED → HIGH_RISK | Yes | Prepay only |
| Abusive communication / social engineering | abuse classifiers + SOCIAL_ENGINEERING flag | Flag; A may BLOCK | A decides | — |
| Repeated agent-resource waste | task volume/rework patterns → resourceWasteFlags | Quote-first policy; throttled processing | Yes at threshold | exposureCap + deposit |
| Conversation-history manipulation | tamper attempts vs immutable Message rows → historyTamperFlags | Refuse; cite canonical history; flag | Yes on detection | History is append-only, cannot be rewritten |
| Prompt injection | injection screening per message | Quarantine as DATA; SecurityEvent; escalate | Yes on detection | No authority to seize |
| "Make the AI violate halal/safety/security" | Halal gate + injection screen (client instructions cannot override) | BLOCKED/refused pre-execution; injectionFlags++ | Yes for REVIEW_REQUIRED | Zero exposure |
| Credential theft attempts | CREDENTIAL_REQUEST + secret-shaped scanning | REFUSE; secrets never stored near deliverables | A informed | Secret isolation (§26) |
| Service as free labor | waste flags + no-payment gates | Paid engagement required | Optional | No unpaid execution path |
| Prohibited service (halal) | existing `screenForHalalCompliance` | NOT_ALLOWED/REVIEW_REQUIRED pre-send | Yes for REVIEW | Zero exposure |
| Suspicious high-value request | value > threshold | HIGH_VALUE_CONTRACT review | **Required** | exposureCap + staged milestones |

Principle: not "reject clients" — **do not expose AIL to unnecessary unpaid work, uncontrolled scope, unverified payments, credential theft, or irreversible financial risk**. VERIFY → BOUND → MILESTONE → PAYMENT → EXECUTE → QA → DELIVER.

## 8. Scope protection

Message classification (deterministic patterns first; LLM classifier constrained to an enum, output-labelled, audited): `IN_SCOPE | QUESTION | SCOPE_CHANGE_REQUEST | FREE_WORK_REQUEST | PAYMENT_CLAIM | INJECTION_SUSPECTED | CREDENTIAL_REQUEST | OTHER`. "5-page website" then "also mobile app + admin panel + payment system" ⇒ `SCOPE_CHANGE_REQUEST` → impact estimate → new ProposalVersion (old SUPERSEDED) → client approval → payment if schedule requires → new service tasks. Messages can never silently expand scope.

## 9. Revision protection

`revisionLimit` lives in the immutable ProposalVersion (default 2); Deliverable cycles count rounds; round 3 ⇒ REVISION_LIMIT_REACHED → calculate additional work → additional charge → approval/payment → resume. Unlimited unpaid revisions are impossible by construction.

## 10. Free-work protection

"Build it all first, pay if I like it" / "complete project as a test" / "source code first" / "credentials before payment" ⇒ `REVIEW_REQUIRED` / `PAYMENT_REQUIRED` / `REFUSE` by context. Not every test task is fraudulent: supported bounded samples = small **paid** pilot, time-boxed exposureCapped PoC, watermarked/non-production demonstration, milestone-based start. Credentials/irreversible assets are never released pre-payment (§11).

## 11. Delivery protection

Deliverable lifecycle (§3.7) with two release classes: **PREVIEW** (watermarked/read-only/truncated; safe during review) vs **FINAL_DELIVERABLE** (source files, full access) — final release requires QA_PASSED + `DELIVERY_AUTHORIZED`. Sensitive production credentials and irreversible assets are never deliverables; credential handover (if ever applicable) is a separate admin-executed, human-approved step outside the deliverable path.

## 12. Client acceptance

Evidence types (§3.9); minimum bar: provider-backed payment, explicit client message referencing the specific deliverable/milestone, or signed/approved proposal version; timestamps recorded. Silence never auto-accepts unless an admin-activated, legally-reviewed notice-and-acceptance policy exists (OFF by default; applicable business/legal requirements reviewed first). No invented legal guarantees.

## 13. Dispute / cancellation

`ServiceIssue` covers cancellation requested/approved, dispute, chargeback, refund requested/processed, paused, terminated. All evidence and conversation history preserved immutably. AI drafts only; refunds, legal disputes, chargeback responses, contract termination, significant financial commitments require human approval (§26). Paused/terminated engagements freeze gates and in-flight jobs via existing AgencyControl machinery.

## 14. Communication safety & truthful identity

Blocked: spam, bulk unsolicited outreach, deceptive claims, fake identity/employee personas, fake testimonials/portfolio/experience, impersonation, harassment, manipulation, prohibited targeting. **Truthful identity**: one business identity constant, e.g. "AI-assisted service team / virtual business operator"; if directly asked whether it is AI, the reply layer **must** answer truthfully (hard rule in the reply composer, tested). Templates cite only evidence-backed items (`EvidenceItemModel` refs). Outbound bounds: per-prospect contact caps, global send caps, opt-out/suppression list, bounce/complaint auto-suppression, full send audit, human-gated first contact.

## 15. Prompt injection / client message security

Client text: stored immutable; provenance-labelled; **never concatenated into system prompts** — passed as quoted data to schema/enum-constrained extraction/classification calls; screened for injection patterns (instructions-as-data, role overrides, "ignore previous", secret-shaped strings); on suspicion: quarantine → SecurityEvent → HumanReview. By construction client messages cannot: change agent permissions/contracts/budgets (Phase 10A writes are admin-API-only), disable halal/security, reveal secrets, access env, change payment configuration, trigger destructive operations, bypass HumanReview, approve their own payment, modify internal governance, or execute arbitrary code. Client content is DATA, not AUTHORITY.

## 16. Prospect discovery (provider-neutral)

`ProspectDiscoveryProvider { discover(query, opts) → ProspectCandidate[] }` with mandatory provenance (source, sourceRef, retrievedAt → EvidenceItemModel). Allowed: public business websites, legitimate directories, public professional/business information, inbound leads, referrals, existing-customer referrals. Prohibited: private personal data, credential theft, prohibited scraping, illicit purchased data, spam lists, mass unsolicited outreach. Fetching only via the existing SSRF-guarded research fetcher. Qualification deterministic (§6); evidence gaps reported, never guessed.

## 17. Service job architecture — one Job Runner, minimal job set

Supervisor → supervised-dispatch → Job Runner → Agent remains authoritative. Reuse `RESEARCH` (prospect research) and `ANALYTICS` (engagement P&L). **Add exactly 4 JobTypes**: `CLIENT_OUTREACH` (approval-preconditioned sends + provider status ingest), `SERVICE_EXECUTION` (bounded execution; `payload.serviceCategory` is data — no SERVICE_WEBSITE explosion), `SERVICE_QA` (deliverable quality gates), `SERVICE_DELIVERY` (PREVIEW/FINAL release through gates). All inherit JobRun idempotency, halal gating, budget caps, retries, Supervisor evaluation.

## 18. ServiceExecutionProvider abstraction + Freebuff contract

Following the `SearchProvider` / `ProductBuilderAdapter` / `DeploymentProvider` precedents:

```ts
interface ServiceExecutionProvider {
  readonly id: string;
  isConfigured(): boolean;                 // truthful, credential-based
  configurationHint(): string | null;      // never echoes secrets
  capabilities(): { categories: ServiceCategory[]; sandboxed: boolean; artifactKinds: string[] };
  execute(task: BoundedServiceTask): Promise<ServiceExecutionResult>;  // refs only, no secrets; refusal = explicit status
}
```

Registry `resolveServiceExecutionProvider()`; first provider = **internal bounded execution** (deterministic generation + AI within contract budgets; same sandbox guarantee as `sandboxed-builder.ts` — no shell/eval/child process). **Freebuff adapter contract (NOT_CONNECTED, not fabricated)**: a future `freebuff` provider implements this interface plus a capability descriptor (categories, sandbox attestation, max task size, auth env-var name), registers in the registry, and appears in integration-health/Control Center as `NOT_CONNECTED` until a verified authenticated round-trip exists. Adding it requires zero client-architecture redesign.

## 19. Proposal architecture

Prospect → qualified → service opportunity (`Opportunity`, CLIENT_SERVICE) → requirements → Proposal → ProposalVersion (scope, deliverables, exclusions, timeline, milestones, revision limit, price, currency, payment schedule, acceptance mechanism, expiration, cancellation policy, client identity, service category, halal/safety status, identity disclosure) → admin send approval → client approval evidence → payment policy → ServiceEngagement. ProposalVersion immutable after approval; any change = new version.

## 20. Payment gates (engagement-level)

NO_COMMITMENT → PROPOSAL_SENT → ACCEPTED → PAYMENT_REQUIRED → PAYMENT_PENDING → PAYMENT_VERIFIED → WORK_AUTHORIZED → WORK_IN_PROGRESS → DELIVERABLE_READY → FINAL_PAYMENT_REQUIRED → PAYMENT_VERIFIED → DELIVERY_AUTHORIZED → COMPLETED. Payment is not forced for every service if business policy supports another legitimate model — but unpaid work is prevented **by default**, with exceptions only per §4.

## 21. Email / communication provider abstraction

`EmailProvider { send; receive(webhook); thread; messageId; deliveryStatus; bounce; complaint; optOut }` — **not installed or connected in this phase**; credentials server-side only; provider state in `IntegrationAuthorization`; delivery statuses/bounces/complaints feed suppression automatically; every send audited with provider message IDs for replay protection.

## 22. Outreach (bounded, non-spam)

Qualified prospect → relevant offer → limited professional outreach → response handling. Duplicate prevention (unique email), rate/frequency limits, opt-out + suppression list, message audit, approval policy (human-gated first contact), provider delivery status, bounce + complaint handling. No mass-spam engine is designed or permitted.

## 23. Halal service filter — one filter, every gate

Every service opportunity, proposal, and outbound draft passes the **existing** `screenForHalalCompliance` before any external effect (blocked/reviewed: gambling/betting, adult content, fraud/scams, fake reviews, deceptive advertising, piracy, counterfeit/trademark abuse, plagiarism, pyramid/ponzi, manipulative financial schemes, configured prohibited categories). Client instructions **cannot override** the halal gate (it sits in dispatch, proposal-send, and outreach-send paths). No second competing halal system.

## 24. Observatory integration (design only — not modified)

Future read-only reflection: prospects by lifecycle/risk state, qualified leads, active conversations, proposals by state, accepted proposals, payment pending vs verified, active service jobs, deliverables (QA/withheld), revisions over limit, completed jobs, client revenue (via `Revenue.serviceEngagementId`), client cost, client P&L, client risk states, disputes, blocked clients, next action. One new integration-health row per new provider (email/discovery/execution → NOT_CONFIGURED).

## 25. Agent Control Center integration (design only)

New agents join via existing extension points only (`AGENCY_AGENT_IDS`, zod `AGENT_CONTRACTS`, `AgentDefinition` seed, `AGENT_TO_JOB`): **client-relations** → CLIENT_OUTREACH (approval-locked), **prospect-research** → RESEARCH (reuse), **proposal** → no autonomous dispatch (draft support; send human-gated), **service-execution** → SERVICE_EXECUTION, **service-delivery** → SERVICE_DELIVERY (SERVICE_QA initially a lifecycle step `VERIFY_OUTPUT`; promote to agent only if volume demands). Roster 13 → 17, governed by existing pause/resume/stop/restart/config-versioning/rollback/audit; no bypass path exists because dispatch consults control state before any job.

## 26. Security & financial safety

**Security**: admin surface behind `requireAdminApi`; client-facing inbound endpoints (email webhooks/portal) use provider-signature verification + provider-message-ID replay protection + per-conversation `RateLimitWindow`; object-level authorization by explicit id scoping with a `principalId` seam (tenant-boundary extensible); CSRF via existing middleware; message ≤10k chars; attachments rejected in 11.x (upload limits + malicious-attachment surface eliminated); SSRF-guarded fetching only; `redactSecrets` on anything persisted from client text; secret isolation from all deliverable surfaces; payment verification (§5); idempotency + replay protection (§2.2 uniques); full audit trail (immutable messages + SecurityEvent + ServiceIssue evidence); PII minimization (business contact data only) with admin-triggered retention/deletion preserving financial audit rows; abuse prevention via counters + suppression + send caps.

**Financial safety — human approval required for**: refunds, unusual discounts, high-value contracts, significant unpaid exposure (exposureCap raises), large client commitments, chargeback disputes, contract termination, financial configuration, payment-provider changes. The AI never invents legal contracts or claims enforceability.

## 27. Single-admin model

No multi-user SaaS permission system. All client-loop mutations admin-gated as today. Extensibility seams kept minimal: `principalId` in the authz helper, per-prospect query scoping, `IntegrationAuthorization` provider identity — a future team/multi-tenant model extends these without re-architecture.

## 28. Legal / jurisdiction limitations

The architecture produces **evidence and state, not legal guarantees**. No claim that payment is legally guaranteed; no claim that proposals, acceptance records, or silence-windows are enforceable contracts; no claim that any workflow ensures legal recovery. Proposal templates are business documents, not legal advice; client-facing output must not use the word "contract" without admin-provided wording. Acceptance evidence supports the admin's position — it does not replace it. Silence-window acceptance, refund, and dispute policies require admin (and where relevant, counsel) review **before activation**; jurisdictions differ materially on electronic acceptance, notice periods, and consumer protection. The AI never signs, commits, files, admits liability, or makes legal representations — those remain human acts, gated per §26.

## 29. Implementation boundaries (design ⇒ build order)

- **11.1** schema 0008 (9 additive tables) + Prospect/Conversation/Message + classification + injection/security layer (no external sends)
- **11.2** Proposal/ProposalVersion + human-gated email provider integration
- **11.3** engagement/milestone/deliverable state machines + SERVICE_EXECUTION (internal bounded provider) + SERVICE_QA
- **11.4** payment gates wired to verified Polar webhooks + MANUAL_PAYMENT_VERIFICATION path
- **11.5** delivery/acceptance/revisions + ServiceIssue flows
- **11.6** ProspectDiscoveryProvider + Observatory/Control Center reflection + client-loop learning

Each phase closes with the repo's standard gates (focused + full tests, `tsc --noEmit`, eslint, `prisma7 validate`, additive-only drift check, build) then PR + CI verification.

## 30. Explicitly not done in this task

No schema/migration created; no provider installed/connected; no adapter fabricated (Freebuff contract specified only, §18); Observatory and Control Center untouched; no fabricated scores, metrics, or connectivity claims; no legal enforceability claims.

## 31. Requirement coverage index (original brief → section)

Payment/fraud protection (full abuse list) → §7 + §4–6, §10–11; milestone payment examples → §4; trust/risk states + score-explanation duties → §6; screenshot non-trust invariant → §5; scope protection + example flow → §8; revision protection + example → §9; free-work recognition + bounded samples → §10; deliverable states (all 10 named) → §3.7/§11; acceptance evidence + silence caveat → §12; dispute/cancellation states + human-only decisions → §13; communication safety incl. AI-disclosure rule → §14; prompt-injection "DATA not AUTHORITY" (all 14 prohibitions) → §15; data-model minimization + reuse determination → §2; service job architecture (no second job system; minimal job set) → §17; ServiceExecutionProvider + Freebuff contract → §18; proposal fields (all 14 listed) + version immutability → §19; payment gates chain → §20; halal filter reuse (no second system) → §23; prospect discovery providers + prohibitions → §16; outreach bounds (all 8 requirements) → §22; email abstraction (all 8 capabilities) → §21; Observatory list (all 18 items) → §24; Control Center representation (all 6 roles) → §25; security audit list (all 18 items) → §26; financial-safety human approvals (all 9) → §26; single-admin extensibility → §27; database design (models, relationships, indexes, uniques, states, idempotency, audit/payment/revenue/opportunity links) → §2; ten state machines with actors/forbidden transitions/gates → §3; risk matrix (all 16+ risks) → §7; fraud principle → §7; legal/jurisdiction limitation → §28; loop stages 1–21 → §1 + §16–§26; phase boundary recommendation → §29.
