/**
 * Whether a CREDENTIAL may run code in a drive — the principal half of the
 * drive edit bar `canRunCode` applies to the acting USER.
 *
 * `canRunCode` asks `getUserDrivePermissions(userId, driveId).canEdit`, which is
 * the owning user's answer. A drive-scoped key is "the user it belongs to,
 * narrowed by scope, optionally weakened by an explicit role", so an owner's
 * key downgraded to a view-only custom role would clear that gate on its
 * owner's access (PR #2653 review P1). This asks the SAME drive-wide edit
 * question of the credential's own grant, read through the centralized
 * principal layer:
 *
 * - no membership in the drive → no;
 * - INHERIT (role null) → the owner's drive-wide edit;
 * - OWNER/ADMIN → yes (admins bypass custom roles, as for a human);
 * - MEMBER → yes, unless a custom role bounds it, in which case only that
 *   role's `driveWidePermissions.canEdit`; an unresolvable role fails closed.
 *
 * `getPrincipalDriveAccessLevel(...).canEdit` is NOT this question: at the
 * drive root it grants edit to ANY membership (members may create root pages),
 * so a view-only custom role reads `canEdit: true` there.
 *
 * It does not replace the user gate — both must pass.
 */

import { getPrincipalDriveMembership, type AuthResult } from '@/lib/auth';
import { getUserDrivePermissions } from '@pagespace/lib/permissions/permissions';
import { fetchCustomRolePermissions } from '@pagespace/lib/permissions/membership-queries';

export async function canPrincipalRunCodeInDrive(auth: AuthResult, driveId: string): Promise<boolean> {
  const membership = await getPrincipalDriveMembership(auth, driveId);
  if (!membership) return false;
  if (membership.role === null) {
    return (await getUserDrivePermissions(auth.userId, driveId))?.canEdit === true;
  }
  if (membership.role === 'OWNER' || membership.role === 'ADMIN') return true;
  if (!membership.customRoleId) return true;
  const customRole = await fetchCustomRolePermissions(membership.customRoleId, driveId);
  return customRole?.driveWidePermissions?.canEdit === true;
}
