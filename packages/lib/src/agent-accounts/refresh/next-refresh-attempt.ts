import type { RefreshAttemptFact } from './decide-refresh';

export const REFRESH_BACKOFF_BASE_MS = 30_000;
export const REFRESH_BACKOFF_MAX_MS = 900_000;

export type RefreshAttemptOutcome =
  | { readonly kind: 'refreshed' }
  | { readonly kind: 'retryable'; readonly retryAfterMs: number | null }
  | { readonly kind: 'definitive' }
  | { readonly kind: 'rotation_replayed' };

export function nextRefreshAttempt(_input: {
  readonly previous: RefreshAttemptFact | null;
  readonly outcome: RefreshAttemptOutcome;
  readonly now: number;
}): RefreshAttemptFact | null {
  throw new Error('nextRefreshAttempt: not implemented (RED)');
}
