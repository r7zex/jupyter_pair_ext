/**
 * Route-selection policy for Pair Notebook connections.
 *
 * Pure, deterministic scoring used by the make-before-break optimizer. The
 * policy encodes two mandatory behaviours:
 *
 * 1. A healthy direct route always beats a relayed route - relaying exists
 *    only because direct ICE failed, so any VERIFIED stable direct candidate
 *    is an improvement regardless of raw latency.
 * 2. Direct-vs-direct migrations require a MEANINGFUL improvement: a 1 ms
 *    gain must never cause route flap. Hysteresis is enforced through a
 *    minimum improvement ratio plus a clean-recent-failures requirement.
 */

export interface RouteQualitySnapshot {
  kind: 'direct' | 'relay';
  /** Latest smoothed RTT in ms; negative means "not yet measured". */
  rttMs: number;
  /** Transport/attempts failures observed in the recent stability window. */
  recentFailures: number;
}

/** Direct-vs-direct candidates must beat the incumbent by at least 20%. */
export const MIN_DIRECT_IMPROVEMENT_RATIO = 0.8;

export interface MigrationDecision {
  migrate: boolean;
  reason:
    | 'candidate-unverified'
    | 'candidate-unstable'
    | 'relay-to-direct'
    | 'meaningful-direct-improvement'
    | 'marginal-improvement'
    | 'candidate-not-better';
}

function verified(snapshot: RouteQualitySnapshot): boolean {
  return snapshot.rttMs >= 0;
}

/**
 * Decides whether a fully verified candidate route may replace the active
 * one. Candidates arrive here only AFTER cryptographic authentication,
 * bidirectional probing and the stability window, so "verified" here refers
 * to having usable RTT measurements.
 */
export function shouldMigrateRoute(
  current: RouteQualitySnapshot,
  candidate: RouteQualitySnapshot,
): MigrationDecision {
  if (!verified(candidate)) return { migrate: false, reason: 'candidate-unverified' };
  if (candidate.recentFailures > 0) return { migrate: false, reason: 'candidate-unstable' };

  if (current.kind === 'relay' && candidate.kind === 'direct') {
    return { migrate: true, reason: 'relay-to-direct' };
  }

  // Direct-vs-direct: meaningful improvement only (hysteresis).
  if (current.kind === 'direct' && candidate.kind === 'direct') {
    const reference = current.rttMs >= 0 ? current.rttMs : Number.POSITIVE_INFINITY;
    if (candidate.rttMs < reference * MIN_DIRECT_IMPROVEMENT_RATIO) {
      return { migrate: true, reason: 'meaningful-direct-improvement' };
    }
    if (candidate.rttMs <= reference) return { migrate: false, reason: 'marginal-improvement' };
    return { migrate: false, reason: 'candidate-not-better' };
  }

  // Never migrate direct -> relay.
  return { migrate: false, reason: 'candidate-not-better' };
}