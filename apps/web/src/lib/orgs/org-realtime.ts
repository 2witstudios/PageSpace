/**
 * Which cached org projections an `org:changed` event invalidates (X-4, PR #2763 M3(c)). The
 * payload carries no amounts: the client refetches its own projections. Pure, so the hook stays
 * a thin socket listener.
 */
import type { OrgChangedPayload } from '@pagespace/lib/realtime/org-wallet-events';
import { isOrgKey, orgKeys } from './org-api';

/** A key matcher for SWR's `mutate(matcher)`. */
export function orgChangeRefreshes(payload: OrgChangedPayload, viewedOrgId: string | undefined): (key: unknown) => boolean {
  const refreshesList = payload.change === 'membership' || payload.change === 'status';
  return (key) => {
    if (typeof key !== 'string') return false;
    if (refreshesList && key === orgKeys.mine()) return true;
    return viewedOrgId === payload.orgId && isOrgKey(payload.orgId, key);
  };
}
