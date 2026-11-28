/**
 * `nextRefreshAttempt` — the attempt fact the refresh worker records after a
 * refresh, which `decideRefresh` reads next time (ADR 0003 §5 F4/F5). Pure.
 *
 * - `refreshed` clears the record (null).
 * - `retryable` counts one more consecutive failure and waits the LONGER of
 *   the provider's Retry-After and `base · 2^(n-1)` capped at the max, so a
 *   provider is never hammered and a long Retry-After is never shortened.
 *   `decideRefresh` stops at `REFRESH_MAX_CONSECUTIVE_FAILURES`.
 * - `definitive` (revoked / purge-and-reauth) schedules nothing and exhausts
 *   the attempt count, so `decideRefresh` alone answers `needs_reauth`
 *   (`exhausted`) from then on — the worker cannot retry-loop on a dead grant
 *   even before anything reads the account's `needs_reauth` status.
 * - `rotation_replayed` is recorded and survives every later outcome but a
 *   success, so `decideRefresh` answers `needs_reauth` from then on.
 */
import { REFRESH_MAX_CONSECUTIVE_FAILURES, type RefreshAttemptFact } from './decide-refresh';

export const REFRESH_BACKOFF_BASE_MS = 30_000;
export const REFRESH_BACKOFF_MAX_MS = 900_000;

export type RefreshAttemptOutcome =
  | { readonly kind: 'refreshed' }
  | { readonly kind: 'retryable'; readonly retryAfterMs: number | null }
  | { readonly kind: 'definitive' }
  | { readonly kind: 'rotation_replayed' };

export function nextRefreshAttempt({
  previous,
  outcome,
  now,
}: {
  readonly previous: RefreshAttemptFact | null;
  readonly outcome: RefreshAttemptOutcome;
  readonly now: number;
}): RefreshAttemptFact | null {
  const failures = previous?.consecutiveFailures ?? 0;
  const replayed = previous?.rotationReplayed ?? false;
  switch (outcome.kind) {
    case 'refreshed':
      return null;
    case 'rotation_replayed':
      return { at: now, consecutiveFailures: failures, retryAt: null, rotationReplayed: true };
    case 'definitive':
      return { at: now, consecutiveFailures: REFRESH_MAX_CONSECUTIVE_FAILURES, retryAt: null, rotationReplayed: replayed };
    case 'retryable': {
      const consecutiveFailures = failures + 1;
      const backoff = Math.min(REFRESH_BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1), REFRESH_BACKOFF_MAX_MS);
      const wait = Math.max(backoff, outcome.retryAfterMs ?? 0);
      return { at: now, consecutiveFailures, retryAt: now + wait, rotationReplayed: replayed };
    }
  }
}
