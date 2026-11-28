/**
 * `createAccountChangeLock` — the per-account lock the authority's changes run
 * under (slice 2): a main-DB advisory lock, so two web replicas editing one
 * account never interleave describe → rebind → record. Non-blocking: a change
 * that finds it held is `busy` (the UI says "someone else is changing it").
 */
import { withAdvisoryLock, type AdvisoryLockPool } from '@pagespace/db/advisory-lock';
import type { AccountAuthorityDeps } from './account-authority-executor';

export function createAccountChangeLock(pool: AdvisoryLockPool): AccountAuthorityDeps['lockAccount'] {
  return async (accountId, fn) => {
    const locked = await withAdvisoryLock(pool, `agent-accounts:change:${accountId}`, () => fn());
    return locked.outcome === 'acquired' ? { acquired: true, result: locked.result } : { acquired: false };
  };
}
