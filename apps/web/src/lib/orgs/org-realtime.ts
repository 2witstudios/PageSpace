/**
 * Which cached org projections an `org:changed` event invalidates (X-4, PR #2763 M3(c)). The
 * payload carries no amounts: the client refetches its own projections. Pure, so the hook stays
 * a thin socket listener.
 */
import type { OrgChangedPayload, WalletChangedPayload } from '@pagespace/lib/realtime/org-wallet-events';
import { isOrgKey, orgKeys, orgReadKeys } from './org-api';

/** A key matcher for SWR's `mutate(matcher)`. */
export function orgChangeRefreshes(payload: OrgChangedPayload, viewedOrgId: string | undefined): (key: unknown) => boolean {
  const refreshesList = payload.change === 'membership' || payload.change === 'status';
  return (key) => {
    if (typeof key !== 'string') return false;
    if (refreshesList && key === orgKeys.mine()) return true;
    return viewedOrgId === payload.orgId && isOrgKey(payload.orgId, key);
  };
}

/**
 * Which org projections a `wallet:changed` (room drive:<id>:wallet) invalidates: the pool split and the seat
 * caps, when the drive is one the page shows. Payloads carry no amounts; the page refetches its read.
 */
export function walletChangeRefreshes(payload: WalletChangedPayload, orgId: string, driveIds: readonly string[]): (key: unknown) => boolean {
  if (!driveIds.includes(payload.driveId)) return () => false;
  const keys = new Set([orgReadKeys.pool(orgId), orgReadKeys.seatCaps(orgId)]);
  return (key) => typeof key === 'string' && keys.has(key);
}
