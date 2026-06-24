export type RecoveryDecision = 'rejoin' | 'refetch' | 'regenerate';

/**
 * Pure decision helper for the rejoin-first recovery tree.
 *
 * Priority: rejoin a still-live server stream > return the already-persisted
 * result > regenerate (last resort, genuine failure).
 */
export function decideRecovery({
  hasLiveStream,
  hasPersistedReply,
}: {
  hasLiveStream: boolean;
  hasPersistedReply: boolean;
}): RecoveryDecision {
  if (hasLiveStream) return 'rejoin';
  if (hasPersistedReply) return 'refetch';
  return 'regenerate';
}
