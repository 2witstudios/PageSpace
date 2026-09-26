/**
 * `decideRefresh` — the refresh worker's per-account lifecycle decision
 * (ADR 0005 §5.1, §9; mirrors ADR 0003 §5 F2–F5). Pure: the worker gathers
 * the facts (the material it resolved, whether another refresher holds the
 * per-account lock, what the last attempt recorded) and acts on the verdict.
 *
 * Order matters and is the contract:
 * 1. A rotated refresh token presented a second time (RFC 9700 §4.14.2) means
 *    someone else holds the family: reauthorize whatever else is true, even
 *    while the access token still looks fresh.
 * 2. An access token valid beyond `marginMs` is used; the refresh token is not
 *    spent. A non-finite expiry is never trusted as fresh.
 * 3. No refresh token → the human reconnects.
 * 4. Another refresher holds the lock → do not refresh a second time; the
 *    caller waits for that refresh and re-resolves.
 * 5. The consecutive-failure cap → stop retrying (no retry loop, ADR 0003 F5).
 * 6. A retry time from the last failure (Retry-After, backoff) not yet passed
 *    → wait. The caller must not use an expired access token while waiting.
 */
import type { SecretMaterialByKind } from '../store/store-adapter';

/** What the worker recorded about the previous refresh attempt for this account. */
export type RefreshAttemptFact = {
  /** ms since epoch. */
  readonly at: number;
  /** Retryable failures since the last successful refresh. */
  readonly consecutiveFailures: number;
  /** ms since epoch before which no refresh may be attempted, or null. */
  readonly retryAt: number | null;
  /** The provider reported a rotated refresh token was presented again. */
  readonly rotationReplayed: boolean;
};

/** Retryable failures in a row before the worker gives up and asks for reauthorization. */
export const REFRESH_MAX_CONSECUTIVE_FAILURES = 5;

export type RefreshDecision =
  | { readonly action: 'refresh' }
  | { readonly action: 'skip'; readonly reason: 'fresh' | 'locked' | 'backoff' }
  | { readonly action: 'needs_reauth'; readonly reason: 'no_refresh_token' | 'rotation_replay' | 'exhausted' };

export function decideRefresh({
  material,
  now,
  marginMs,
  lockHeld,
  lastAttempt,
}: {
  readonly material: SecretMaterialByKind['oauth2'];
  readonly now: number;
  readonly marginMs: number;
  readonly lockHeld: boolean;
  readonly lastAttempt: RefreshAttemptFact | null;
}): RefreshDecision {
  if (lastAttempt !== null && lastAttempt.rotationReplayed) return { action: 'needs_reauth', reason: 'rotation_replay' };
  if (Number.isFinite(material.accessExpiresAt) && material.accessExpiresAt - now > marginMs) return { action: 'skip', reason: 'fresh' };
  if (material.refreshToken === null) return { action: 'needs_reauth', reason: 'no_refresh_token' };
  if (lockHeld) return { action: 'skip', reason: 'locked' };
  if (lastAttempt !== null && lastAttempt.consecutiveFailures >= REFRESH_MAX_CONSECUTIVE_FAILURES) return { action: 'needs_reauth', reason: 'exhausted' };
  if (lastAttempt !== null && lastAttempt.retryAt !== null && now < lastAttempt.retryAt) return { action: 'skip', reason: 'backoff' };
  return { action: 'refresh' };
}
