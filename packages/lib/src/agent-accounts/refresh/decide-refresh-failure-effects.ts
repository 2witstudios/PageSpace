/**
 * `decideRefreshFailureEffects` — what the refresh worker records and marks
 * after `classifyRefreshFailure` (task requirement 3: a provider revocation
 * marks the connection and never retry-loops). Pure.
 *
 * `revoked` and `purge_and_reauth` both end the attempt (`definitive`, no
 * retry scheduled) and set the account `needs_reauth` — the human reconnects.
 * `retryable` records the failure with the provider's delay and leaves the
 * account's status alone; `decideRefresh` stops at the failure cap.
 */
import type { RefreshFailureClass } from './classify-refresh-failure';
import type { RefreshAttemptOutcome } from './next-refresh-attempt';

export type RefreshFailureEffects = {
  readonly attempt: RefreshAttemptOutcome;
  /** The `agent_accounts.status` to set, or null to leave it. */
  readonly accountStatus: 'needs_reauth' | null;
};

export function decideRefreshFailureEffects({ failure }: { readonly failure: RefreshFailureClass }): RefreshFailureEffects {
  if (failure.class === 'retryable') return { attempt: { kind: 'retryable', retryAfterMs: failure.retryAfterMs }, accountStatus: null };
  return { attempt: { kind: 'definitive' }, accountStatus: 'needs_reauth' };
}
