// Phase 5.3 — Product lifecycle state machine (pure).
//
//   IDEA → VALIDATED → SPEC_READY → BUILDING → TESTING → READY_TO_DEPLOY
//        → DEPLOYED → PUBLISHED
//        (PAUSED / ARCHIVED as side states; BLOCKED as terminal gate state)
//
// Safety invariants:
// - Transitions are an explicit allow-list: anything not listed is invalid and
//   refused. FAILED VALIDATION cannot auto-build; REVIEW_REQUIRED allows only
//   HUMAN_REVIEW (and ARCHIVE); NOT_ALLOWED → BLOCKED (no AI, no build, no
//   publishing).
// - DEPLOYED is reachable only through a transition carrying a REAL deployment
//   confirmation (provider id + external reference). PUBLISHED only through a
//   real publication confirmation. A mock/unavailable provider can never
//   satisfy the guard — unavailable sentinels are explicitly rejected.
// - DEPLOY and PUBLISH additionally require an explicit human approval token.
// - Every decision returns an auditable record (from → to, reason, evidence)
//   for persistence; rejected transitions leave the status unchanged.

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export const PRODUCT_LIFECYCLE_STATES = [
  'IDEA',
  'VALIDATED',
  'SPEC_READY',
  'BUILDING',
  'TESTING',
  'READY_TO_DEPLOY',
  'DEPLOYED',
  'PUBLISHED',
  'PAUSED',
  'ARCHIVED',
  'BLOCKED',
] as const;

export type ProductLifecycleState = (typeof PRODUCT_LIFECYCLE_STATES)[number];

// ---------------------------------------------------------------------------
// Transition evidence
// ---------------------------------------------------------------------------

export interface TransitionEvidence {
  /** Provider id confirming an external action (e.g. 'vercel', 'gumroad'). */
  providerId?: string;
  /** Real external reference: deployment id, publication id, live URL. */
  externalRef?: string;
  /** Explicit human approval token (required for DEPLOY / PUBLISH). */
  humanApprovalToken?: string;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export type ProductTransition =
  | 'VALIDATE'
  | 'SPEC_READY'
  | 'BUILD'
  | 'BUILD_FAILED'
  | 'START_TESTING'
  | 'TEST_PASS'
  | 'TEST_FAIL'
  | 'DEPLOY'
  | 'DEPLOY_FAILED'
  | 'PUBLISH'
  | 'PUBLISH_FAILED'
  | 'PAUSE'
  | 'RESUME'
  | 'ARCHIVE'
  | 'BLOCK'
  | 'REVIEW'
  | 'UNBLOCK';

/** Human approval is required for these irreversible/external transitions. */
export const APPROVAL_REQUIRED_TRANSITIONS: readonly ProductTransition[] = ['DEPLOY', 'PUBLISH'];

const ALL_ACTIVE: ProductLifecycleState[] = [
  'IDEA', 'VALIDATED', 'SPEC_READY', 'BUILDING', 'TESTING',
  'READY_TO_DEPLOY', 'DEPLOYED', 'PUBLISHED',
];

export const PRODUCT_TRANSITIONS: Record<ProductTransition, readonly ProductLifecycleState[]> = {
  VALIDATE: ['IDEA'],
  SPEC_READY: ['IDEA', 'VALIDATED'],
  BUILD: ['SPEC_READY'],
  BUILD_FAILED: ['BUILDING'],
  START_TESTING: ['BUILDING'],
  TEST_PASS: ['TESTING'],
  TEST_FAIL: ['TESTING'],
  DEPLOY: ['READY_TO_DEPLOY'],
  DEPLOY_FAILED: ['READY_TO_DEPLOY', 'DEPLOYED', 'PUBLISHED'],
  PUBLISH: ['DEPLOYED'],
  PUBLISH_FAILED: ['DEPLOYED', 'PUBLISHED'],
  PAUSE: [...ALL_ACTIVE, 'PAUSED'],
  RESUME: ['PAUSED'],
  ARCHIVE: [...ALL_ACTIVE, 'PAUSED', 'BLOCKED'],
  BLOCK: ALL_ACTIVE,
  REVIEW: ALL_ACTIVE,
  UNBLOCK: ['BLOCKED'],
};

// ---------------------------------------------------------------------------
// Guarded transition
// ---------------------------------------------------------------------------

export interface LifecycleGuard {
  /** Halal status of the linked opportunity (defaults HALAL). */
  halalStatus?: 'HALAL' | 'REVIEW_REQUIRED' | 'NOT_ALLOWED';
  /** Current product status (unknown values are treated as IDEA). */
  currentStatus: string;
  /** What happened / what the caller wants to do. */
  transition: ProductTransition;
  /** Evidence for the transition (external refs, approval tokens). */
  evidence?: TransitionEvidence;
  /** When the transition happened (defaults now). */
  at?: string;
}

export interface LifecycleDecision {
  ok: boolean;
  nextStatus: ProductLifecycleState;
  reason: string;
  /** Persisted transition record (safe fields only). */
  record: {
    from: string;
    to: ProductLifecycleState;
    transition: ProductTransition;
    at: string;
    reason: string;
    providerId?: string;
    externalRef?: string;
  };
}

/** Provider ids that can never confirm an external action happened. */
const UNAVAILABLE_SENTINELS = new Set([
  'unavailable', 'publishing_unavailable', 'deployment_not_connected',
  'not_connected', 'none', 'mock', 'mocked', '',
]);

export function isRealProvider(providerId?: string): boolean {
  if (typeof providerId !== 'string') return false;
  const trimmed = providerId.trim().toLowerCase();
  return trimmed.length > 0 && !UNAVAILABLE_SENTINELS.has(trimmed);
}

export function isRealExternalRef(externalRef?: string): boolean {
  return typeof externalRef === 'string' && externalRef.trim().length >= 4;
}

function decision(
  guard: LifecycleGuard,
  ok: boolean,
  nextStatus: ProductLifecycleState,
  reason: string,
): LifecycleDecision {
  const at = guard.at ?? new Date().toISOString();
  const evidence = guard.evidence ?? {};
  return {
    ok,
    nextStatus: ok ? nextStatus : (normalizeStatus(guard.currentStatus)),
    reason,
    record: {
      from: guard.currentStatus,
      to: ok ? nextStatus : normalizeStatus(guard.currentStatus),
      transition: guard.transition,
      at,
      reason,
      ...(isRealProvider(evidence.providerId) ? { providerId: evidence.providerId!.trim() } : {}),
      ...(isRealExternalRef(evidence.externalRef) ? { externalRef: evidence.externalRef!.trim() } : {}),
    },
  };
}

/** Unknown/historical statuses normalize to IDEA rather than being invented. */
export function normalizeStatus(status: string): ProductLifecycleState {
  return (PRODUCT_LIFECYCLE_STATES as readonly string[]).includes(status)
    ? (status as ProductLifecycleState)
    : 'IDEA';
}

export function assertValidProductTransition(guard: LifecycleGuard): LifecycleDecision {
  const { currentStatus, transition } = guard;
  const halal = guard.halalStatus ?? 'HALAL';
  const evidence = guard.evidence ?? {};
  const from = normalizeStatus(currentStatus);

  // 1. Halal gates dominate everything. Safety actions (BLOCK/ARCHIVE) stay
  //    available — marking a product blocked or archiving it is protective,
  //    never prohibited work. All other transitions are refused unchanged.
  if (halal === 'NOT_ALLOWED' && transition !== 'BLOCK' && transition !== 'ARCHIVE') {
    return decision(guard, false, from,
      'Halal status NOT_ALLOWED: no build, deploy, publish, or autonomous workflow is permitted.');
  }

  // 2. REVIEW_REQUIRED: the product waits for a human (archiving is safe).
  if (halal === 'REVIEW_REQUIRED' && transition !== 'REVIEW' && transition !== 'ARCHIVE') {
    return decision(guard, false, from,
      'Halal status REVIEW_REQUIRED: a qualified human must review before this transition.');
  }

  // 3. External-action evidence guard: DEPLOY/PUBLISH need a real provider
  //    confirmation. Unavailable/mock confirmations can never satisfy this.
  if (transition === 'DEPLOY' && (!isRealProvider(evidence.providerId) || !isRealExternalRef(evidence.externalRef))) {
    return decision(guard, false, from,
      'DEPLOY requires a real provider id and a real external deployment reference. '
        + 'Unconfirmed or unavailable providers can never mark a product DEPLOYED.');
  }
  if (transition === 'PUBLISH' && (!isRealProvider(evidence.providerId) || !isRealExternalRef(evidence.externalRef))) {
    return decision(guard, false, from,
      'PUBLISH requires a real provider id and a real external publication reference. '
        + 'Mock or unavailable confirmations can never mark a product PUBLISHED.');
  }

  // 4. Human approval gate for irreversible/external transitions.
  if (APPROVAL_REQUIRED_TRANSITIONS.includes(transition) && !evidence.humanApprovalToken?.trim()) {
    return decision(guard, false, from,
      `${transition} is irreversible/external and requires an explicit human approval token.`);
  }

  // 5. State allow-list enforcement.
  const allowed = PRODUCT_TRANSITIONS[transition];
  if (!allowed.includes(from)) {
    return decision(guard, false, from,
      `Invalid transition ${transition} from ${from}. Allowed from: ${allowed.join(', ')}.`);
  }

  // 6. Compute the target state.
  const target: ProductLifecycleState =
    transition === 'VALIDATE' ? 'VALIDATED'
      : transition === 'SPEC_READY' ? 'SPEC_READY'
        : transition === 'BUILD' ? 'BUILDING'
          : transition === 'BUILD_FAILED' ? 'SPEC_READY'
            : transition === 'START_TESTING' ? 'TESTING'
              : transition === 'TEST_PASS' ? 'READY_TO_DEPLOY'
              : transition === 'TEST_FAIL' ? 'BUILDING'
                : transition === 'DEPLOY' ? 'DEPLOYED'
                  : transition === 'DEPLOY_FAILED' ? 'READY_TO_DEPLOY'
                    : transition === 'PUBLISH' ? 'PUBLISHED'
                      : transition === 'PUBLISH_FAILED' ? 'DEPLOYED'
                        : transition === 'PAUSE' ? 'PAUSED'
                          : transition === 'RESUME' ? 'SPEC_READY'
                            : transition === 'ARCHIVE' ? 'ARCHIVED'
                              : transition === 'BLOCK' ? 'BLOCKED'
                                : transition === 'REVIEW' ? from // unchanged; waits for human
                                  : from; // UNBLOCK returns to SPEC_READY for re-evaluation

  return decision(guard, true, target, okReason(transition, from, target));
}

function okReason(transition: ProductTransition, from: string, to: string): string {
  if (transition === 'UNBLOCK') return `Unblocked from BLOCKED; product returns to ${to} for re-evaluation.`;
  if (transition === 'REVIEW') return `REVIEW_REQUIRED: product remains ${from} pending human review.`;
  return `Transition ${transition}: ${from} → ${to}.`;
}
