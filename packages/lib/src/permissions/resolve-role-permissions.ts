import type { PermissionLevel } from './permissions';
import type { CustomRolePerms } from './membership-queries';

export function resolveRolePermissions(
  role: 'OWNER' | 'ADMIN' | 'MEMBER',
  customRolePermissions: CustomRolePerms | null,
  targetPageId: string,
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

  return { canView: true, canEdit: false, canShare: false, canDelete: false };
}
