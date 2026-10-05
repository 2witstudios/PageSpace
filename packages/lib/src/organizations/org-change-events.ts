/**
 * Announce an org change to its members in realtime (Spec X-4): `org:changed` on each accepted
 * member's notifications channel (realtime/org-wallet-events). The recipients are the org's
 * member rows (a pending invitation is not a membership and is told nothing). Never throws.
 */
import { emitOrgChanged, type OrgChange } from '../realtime/org-wallet-events';
import { listOrgMembers } from './repository';

export async function announceOrgChange(orgId: string, change: OrgChange): Promise<void> {
  await emitOrgChanged({ orgId, change }, async (id) => (await listOrgMembers(id)).map((m) => m.userId));
}
