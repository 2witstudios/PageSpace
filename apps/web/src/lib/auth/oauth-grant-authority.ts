/**
 * Consent-time / device-decision grant-authority resolution (ADR 0002
 * Decision 2). Shared by the authorization-code consent screen
 * (`/api/oauth/authorize`) and the device-authorization approval decision
 * (`/api/oauth/device_authorization/decision`) — both mint a grant from
 * user-approved scopes and must enforce the exact same authority caps before
 * doing so, so the DB-backed lookup lives in one place and both routes hand
 * the result straight to the pure `checkGrantAuthority`.
 */
import type { ScopeSet, GrantAuthority } from '@pagespace/lib/auth/oauth/scopes';
import { getDriveAccess } from '@pagespace/lib/services/drive-service';
import { customRoleBelongsToDrive, getMemberCustomRoleId } from '@pagespace/lib/permissions/membership-queries';

export async function resolveGrantAuthority(scopes: ScopeSet, userId: string): Promise<GrantAuthority> {
  const entries = await Promise.all(
    Array.from(scopes.drives, async ([driveId, scope]) => {
      const [access, ownCustomRoleId, customRoleOk] = await Promise.all([
        getDriveAccess(driveId, userId),
        getMemberCustomRoleId(driveId, userId),
        scope.role.kind === 'custom' ? customRoleBelongsToDrive(scope.role.customRoleId, driveId) : Promise.resolve(true),
      ]);

      return [
        driveId,
        {
          isOwner: access.isOwner,
          isMember: access.isMember,
          isAdmin: access.isAdmin,
          ownCustomRoleId,
          roleBelongsToDrive: () => customRoleOk,
        },
      ] as const;
    }),
  );

  return new Map(entries);
}
