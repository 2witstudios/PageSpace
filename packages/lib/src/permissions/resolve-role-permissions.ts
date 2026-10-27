import type { PermissionLevel } from './permissions';
import type { CustomRolePerms } from './membership-queries';

/**
 * Resolve a standard drive role to page permissions.
 *
 * `pageType` is the target page's `pages.type`, or null when the target is a
 * drive id (drive-as-root-node). A plain MEMBER with no custom role is
 * view-only EXCEPT on channels, where members can post — the same
 * Discord/Slack rule the user path (permissions.ts) and the app path
 * (app-permissions.ts) apply, so an agent member never has less reach in a
 * channel than the human or app member who added it.
 */
export function resolveRolePermissions(
  role: 'OWNER' | 'ADMIN' | 'MEMBER',
  customRolePermissions: CustomRolePerms | null,
  targetPageId: string,
  pageType: string | null,
): PermissionLevel {
  if (role === 'ADMIN' || role === 'OWNER') {
    return { canView: true, canEdit: true, canShare: true, canDelete: true };
  }

  if (customRolePermissions) {
    const perms = customRolePermissions[targetPageId];
    return {
      canView: perms?.canView ?? false,
      canEdit: perms?.canEdit ?? false,
      canShare: perms?.canShare ?? false,
      canDelete: false,
    };
  }

  return { canView: true, canEdit: pageType === 'CHANNEL', canShare: false, canDelete: false };
}
