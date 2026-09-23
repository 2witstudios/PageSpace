import type { RefreshFailureClass } from './classify-refresh-failure';
import type { RefreshAttemptOutcome } from './next-refresh-attempt';

export type RefreshFailureEffects = {
  readonly attempt: RefreshAttemptOutcome;
  readonly accountStatus: 'needs_reauth' | null;
};

export function decideRefreshFailureEffects(_input: { readonly failure: RefreshFailureClass }): RefreshFailureEffects {
  throw new Error('decideRefreshFailureEffects: not implemented (RED)');
}
