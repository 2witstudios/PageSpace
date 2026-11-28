/**
 * Independent review of #2762, P1-5: undoing (or redoing) a drive change may write `ownerId` back. When a member
 * leaves an org, each drive they led is handed to someone else and logged as an `ownership_transfer`; rolling that
 * back would make the departed person lead an org drive again. A drive's lead is exempt from the guests policy (it is
 * never parked or asked), so that would let an outsider back in with full control. An org drive's lead must be a
 * member of the org (O-7), so such a write is refused, and nothing is written.
 */
import { and, eq } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { orgMembers } from '@pagespace/db/schema/organizations';
import type { RollbackDeps } from './deps';

export const FORMER_MEMBER_LEAD_MESSAGE = 'This drive belongs to an organization, and the person it would hand back to is no longer a member of it, so they cannot lead it again.';

export async function assertRestoredLeadEligible(deps: RollbackDeps, driveId: string, update: Record<string, unknown>): Promise<void> {
  const restoredLead = update['ownerId'];
  if (typeof restoredLead !== 'string') return;
  const [drive] = await deps.db.select({ orgId: drives.orgId }).from(drives).where(eq(drives.id, driveId)).limit(1);
  if (!drive?.orgId) return;
  const [member] = await deps.db
    .select({ id: orgMembers.id })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, drive.orgId), eq(orgMembers.userId, restoredLead)))
    .limit(1);
  if (!member) throw new Error(FORMER_MEMBER_LEAD_MESSAGE);
}
