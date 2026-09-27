// ============================================================================
// AGENCY — DETERMINISTIC HEALTH EVALUATION (Phase 10)
// ============================================================================
// Pure module: no DB, no network, no secrets. Derives the honest agent health
// state (HEALTHY / DEGRADED / BLOCKED / FAILED / UNKNOWN) from REAL run
// history only. Never fabricated: an agent with no runs is UNKNOWN, not
// "healthy", and an agent with no completed work never reports LIVE.
// ============================================================================

import type { HealthEvaluation, HealthEvaluationInput } from './types';

/**
 * Deterministic health derivation from real runs.
 *
 * Rules (in priority order):
 *  1. paused                    → BLOCKED (admin paused this agent)
 *  2. no runs at all            → UNKNOWN (nothing known; never "healthy")
 *  3. running job past timeout  → DEGRADED (stuck run)
 *  4. consecutive failures dominate recent history → FAILED
 *  5. only degraded/blocked runs recently → DEGRADED
 *  6. recent safety rejections  → BLOCKED
 *  7. otherwise                 → HEALTHY
 */
export function evaluateAgentHealth(input: HealthEvaluationInput): HealthEvaluation {
  const reasons: string[] = [];
  const successCount = input.recentRuns.filter((r) => r.status === 'SUCCEEDED').length;
  const failureCount = input.recentRuns.filter((r) => r.status === 'FAILED').length;
  const degradedCount = input.recentRuns.filter((r) => r.status === 'DEGRADED' || r.status === 'BLOCKED').length;
  const lastRunAt = input.recentRuns.reduce<Date | null>((latest, r) => {
    if (!latest || r.startedAt > latest) return r.startedAt;
    return latest;
  }, null);

  if (input.paused) {
    reasons.push('agent paused by the administrator');
    return { state: 'BLOCKED', reasons, successCount, failureCount, lastRunAt };
  }
  if (input.recentRuns.length === 0 && !input.runningJobStartedAt) {
    return { state: 'UNKNOWN', reasons: ['no recorded runs yet'], successCount, failureCount, lastRunAt };
  }

  // Stuck running job: a startedAt with no completion beyond the timeout.
  if (input.runningJobStartedAt) {
    const elapsed = Date.now() - input.runningJobStartedAt.getTime();
    if (elapsed > input.timeoutThresholdMs) {
      reasons.push(`running job has exceeded the timeout threshold (${Math.floor(elapsed / 1000)}s)`);
      return { state: 'DEGRADED', reasons, successCount, failureCount, lastRunAt };
    }
  }

  // Consecutive failures at the head of recency-ordered history.
  const recent = [...input.recentRuns].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  let consecutiveFailures = 0;
  for (const run of recent) {
    if (run.status === 'FAILED') consecutiveFailures += 1;
    else break;
  }
  if (consecutiveFailures >= 3) {
    reasons.push(`${consecutiveFailures} consecutive failed runs`);
    return { state: 'FAILED', reasons, successCount, failureCount, lastRunAt };
  }

  // Safety rejections in recent history block autonomous work.
  const safetyRejections = input.recentRuns.filter((r) => r.safetyVerdict === 'NOT_ALLOWED').length;
  if (safetyRejections > 0) {
    reasons.push(`${safetyRejections} safety rejection(s) in recent runs`);
    return { state: 'BLOCKED', reasons, successCount, failureCount, lastRunAt };
  }

  if (degradedCount > 0 && successCount === 0) {
    reasons.push('recent runs degraded/blocked with no successes');
    return { state: 'DEGRADED', reasons, successCount, failureCount, lastRunAt };
  }
  if (degradedCount > 0) {
    reasons.push(`${degradedCount} degraded/blocked run(s) recently`);
    return { state: 'DEGRADED', reasons, successCount, failureCount, lastRunAt };
  }

  return { state: 'HEALTHY', reasons: ['recent runs completed normally'], successCount, failureCount, lastRunAt };
}
