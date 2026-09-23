import type { SecretMaterialByKind } from '../store/store-adapter';

export type RefreshAttemptFact = {
  readonly at: number;
  readonly consecutiveFailures: number;
  readonly retryAt: number | null;
  readonly rotationReplayed: boolean;
};

export const REFRESH_MAX_CONSECUTIVE_FAILURES = 5;

export type RefreshDecision =
  | { readonly action: 'refresh' }
  | { readonly action: 'skip'; readonly reason: 'fresh' | 'locked' | 'backoff' }
  | { readonly action: 'needs_reauth'; readonly reason: 'no_refresh_token' | 'rotation_replay' | 'exhausted' };

export function decideRefresh(_input: {
  readonly material: SecretMaterialByKind['oauth2'];
  readonly now: number;
  readonly marginMs: number;
  readonly lockHeld: boolean;
  readonly lastAttempt: RefreshAttemptFact | null;
}): RefreshDecision {
  throw new Error('decideRefresh: not implemented (RED)');
}
