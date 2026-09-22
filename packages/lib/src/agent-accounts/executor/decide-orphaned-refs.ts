/**
 * `decideOrphanedRefs` — which plane refs have lost their reference row and
 * must be erased (L2·G2 review MED-1). Pure.
 *
 * `agent_accounts` rows cascade away with their owning user, agent page or
 * drive (erasure included); the plane's material does not. A ref whose
 * account id has no live row is orphaned — unless it is younger than
 * `ORPHAN_GRACE_MS`, so the sweep can never race a create whose row it cannot
 * see yet.
 */
import type { SecretRef } from '../store/store-adapter';

export const ORPHAN_GRACE_MS = 15 * 60_000;

export function decideOrphanedRefs({
  refs,
  liveAccountIds,
  now,
}: {
  readonly refs: readonly { readonly ref: SecretRef; readonly createdAt: number }[];
  readonly liveAccountIds: readonly string[];
  readonly now: number;
}): readonly SecretRef[] {
  const live = new Set(liveAccountIds);
  return refs.filter(({ ref, createdAt }) => !live.has(ref.accountId) && now - createdAt >= ORPHAN_GRACE_MS).map(({ ref }) => ref);
}
