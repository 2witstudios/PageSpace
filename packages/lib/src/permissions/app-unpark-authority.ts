/**
 * Who may UN-PARK a parked published app (review 5407898542 P1).
 *
 * Three people, and nobody else: the app's CREATOR (its cost owner, [D-OW-28]) while they are still
 * a member of the drive; the drive's LEAD; and an org Owner or Admin on an org-owned drive (ORG-4).
 * A plain member, a drive ADMIN who is neither of those, a guest and a stranger are refused. A drive
 * Admin is deliberately not on the list: un-parking spends someone's allowance of the org's credits,
 * and that is the creator's, the lead's or the org's money authority, not a drive role's.
 */

import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { orgMembers } from '@pagespace/db/schema/organizations';
import { ORGS_ENABLED } from '../organizations/orgs-enabled';
import { isDriveLead, type RelationshipDrive } from './drive-relationship';
import { loadEffectiveDriveMembership } from './org-drive-membership';

export type AppUnparkVia = 'lead' | 'org-owner' | 'org-admin' | 'creator';

export type AppUnparkAuthority = { allowed: false } | { allowed: true; via: AppUnparkVia };

export interface AppUnparkAuthorityInput {
  orgsEnabled: boolean;
  userId: string;
  drive: { ownerId: string | null | undefined; orgId: string | null };
  /** The user's role in drive.orgId; null when not a member or the drive has no org. */
  orgRole: 'OWNER' | 'ADMIN' | 'MEMBER' | null;
  /** `published_apps.costOwnerId`: the member whose cap the app counts against; null = the lead. */
  costOwnerId: string | null;
  /** Whether the user is still an effective member of the drive (only read for the creator). */
  isDriveMember: boolean;
}

export function decideAppUnparkAuthority({ orgsEnabled, userId, drive, orgRole, costOwnerId, isDriveMember }: AppUnparkAuthorityInput): AppUnparkAuthority {
  if (isDriveLead(userId, drive)) return { allowed: true, via: 'lead' };
  if (orgsEnabled && drive.orgId !== null) {
    if (orgRole === 'OWNER') return { allowed: true, via: 'org-owner' };
    if (orgRole === 'ADMIN') return { allowed: true, via: 'org-admin' };
  }
  // The creator, only while they can still reach the drive: one removed from it keeps nothing here.
  if (costOwnerId !== null && costOwnerId === userId && isDriveMember) return { allowed: true, via: 'creator' };
  return { allowed: false };
}

/** decideAppUnparkAuthority with its IO: the org role (org drives only) and the creator's membership. */
export async function loadAppUnparkAuthority(
  userId: string,
  drive: RelationshipDrive,
  costOwnerId: string | null,
): Promise<AppUnparkAuthority> {
  let orgRole: AppUnparkAuthorityInput['orgRole'] = null;
  if (ORGS_ENABLED && drive.orgId !== null && !isDriveLead(userId, drive)) {
    const [membership] = await db
      .select({ role: orgMembers.role })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, drive.orgId), eq(orgMembers.userId, userId)))
      .limit(1);
    orgRole = membership?.role ?? null;
  }
  const isDriveMember = costOwnerId === userId && (isDriveLead(userId, drive) || (await loadEffectiveDriveMembership(userId, drive)) !== null);
  return decideAppUnparkAuthority({ orgsEnabled: ORGS_ENABLED, userId, drive, orgRole, costOwnerId, isDriveMember });
}
