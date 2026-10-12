/**
 * Announce an org change to its members in realtime (Spec X-4): `org:changed` on each accepted
 * member's notifications channel (realtime/org-wallet-events). The recipients are the org's
 * member rows (a pending invitation is not a membership and is told nothing). Never throws.
 */
import { emitOrgChanged, type OrgChange } from '../realtime/org-wallet-events';
import { listOrgMembers } from './repository';

/** Who an org change reaches: the org's accepted members, as of now. */
export async function orgChangeAudience(orgId: string): Promise<string[]> {
  return (await listOrgMembers(orgId)).map((m) => m.userId);
}

export async function announceOrgChange(orgId: string, change: OrgChange): Promise<void> {
  await emitOrgChanged({ orgId, change }, orgChangeAudience);
}

/**
 * Announce to an audience read BEFORE the change: a deleted org has no members left to read, so
 * its delete route captures orgChangeAudience first and tells those people afterwards.
 */
export async function announceOrgChangeTo(orgId: string, change: OrgChange, audience: readonly string[]): Promise<void> {
  await emitOrgChanged({ orgId, change }, async () => audience);
}
