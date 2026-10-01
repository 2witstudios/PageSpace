/**
 * The ONE answer to "may this person be added to this drive?" for the org's guests policy (Spec POL-2).
 *
 * Every path that puts a person into an org drive — a direct invite, an emailed invitation, a drive share link, a
 * page share link, the acceptance of a pending invite — asks here at the moment it would create the membership, so
 * the policy is enforced where the effect happens, not only where a request arrives. The decision is the pure
 * decideGuestAdmission; this reads the facts: the drive's org and policies (live, no cache), whether the person
 * belongs to that org, and whether they lead the drive.
 *
 * A person with no account yet (an invite by email) can only be an outsider. The drive's lead is never a guest,
 * even a legacy lead who is outside the org.
 */
import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { orgMembers } from '@pagespace/db/schema/organizations';
import { getDrivePolicies } from '../organizations/policy-reader';
import { decideGuestAdmission, type GuestAdmission } from '../organizations/sharing-decisions';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export interface DriveAdmission {
  decision: GuestAdmission;
  /** The drive's org, or null for a personal drive (always allowed). */
  orgId: string | null;
}

export async function decideOrgDriveAdmission(input: { driveId: string; userId?: string | null }, executor: Executor = db): Promise<DriveAdmission> {
  const context = await getDrivePolicies(input.driveId, executor);
  if (!context) return { decision: 'allow', orgId: null };
  let isOrgMember = false;
  if (input.userId) {
    const [member] = await executor
      .select({ id: orgMembers.id })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, context.orgId), eq(orgMembers.userId, input.userId)))
      .limit(1);
    const [lead] = member ? [] : await executor.select({ id: drives.id }).from(drives).where(and(eq(drives.id, input.driveId), eq(drives.ownerId, input.userId))).limit(1);
    isOrgMember = Boolean(member || lead);
  }
  return { decision: decideGuestAdmission(context.policies, { isOrgMember }), orgId: context.orgId };
}
