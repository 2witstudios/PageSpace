import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthResult } from '@/lib/auth';

const mocks = vi.hoisted(() => ({
  getPrincipalDriveMembership: vi.fn(),
  isDriveScopedPrincipal: vi.fn(),
  getUserDrivePermissions: vi.fn(),
  fetchCustomRolePermissions: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  getPrincipalDriveMembership: mocks.getPrincipalDriveMembership,
  isDriveScopedPrincipal: mocks.isDriveScopedPrincipal,
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({ getUserDrivePermissions: mocks.getUserDrivePermissions }));
vi.mock('@pagespace/lib/permissions/membership-queries', () => ({ fetchCustomRolePermissions: mocks.fetchCustomRolePermissions }));

import { canPrincipalRunCodeInDrive } from '../principal-code-exec-access';

const auth = { userId: 'user-1' } as AuthResult;
const drivePermissions = (canEdit: boolean) => ({ hasAccess: true, isOwner: false, isAdmin: false, isMember: true, canEdit });

describe('canPrincipalRunCodeInDrive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POL-6 (partial) a person (not a drive-scoped credential) asks their own drive-wide edit, which carries the Open-drive floor', async () => {
    mocks.isDriveScopedPrincipal.mockReturnValue(false);
    // The member's default role is view-only, but the org's edit floor lets them edit drive-wide.
    mocks.getPrincipalDriveMembership.mockResolvedValue({ role: 'MEMBER', customRoleId: 'role-view-only' });
    mocks.getUserDrivePermissions.mockResolvedValue(drivePermissions(true));

    expect(await canPrincipalRunCodeInDrive(auth, 'drive-1')).toBe(true);
    expect(mocks.getUserDrivePermissions).toHaveBeenCalledWith('user-1', 'drive-1');
    expect(mocks.fetchCustomRolePermissions).not.toHaveBeenCalled();

    mocks.getUserDrivePermissions.mockResolvedValue(drivePermissions(false));
    expect(await canPrincipalRunCodeInDrive(auth, 'drive-1')).toBe(false);
  });

  it('an inheriting scope is its owner: the owner\'s drive-wide edit', async () => {
    mocks.isDriveScopedPrincipal.mockReturnValue(true);
    mocks.getPrincipalDriveMembership.mockResolvedValue({ role: null, customRoleId: null });
    mocks.getUserDrivePermissions.mockResolvedValue(drivePermissions(true));
    expect(await canPrincipalRunCodeInDrive(auth, 'drive-1')).toBe(true);
  });

  it('an explicit credential role is that role: never the owner\'s floor or access', async () => {
    mocks.isDriveScopedPrincipal.mockReturnValue(true);
    mocks.getUserDrivePermissions.mockResolvedValue(drivePermissions(true));

    mocks.getPrincipalDriveMembership.mockResolvedValue({ role: 'MEMBER', customRoleId: 'role-view-only' });
    mocks.fetchCustomRolePermissions.mockResolvedValue({ permissions: {}, driveWidePermissions: { canView: true, canEdit: false, canShare: false } });
    expect(await canPrincipalRunCodeInDrive(auth, 'drive-1')).toBe(false);

    mocks.fetchCustomRolePermissions.mockResolvedValue(null);
    expect(await canPrincipalRunCodeInDrive(auth, 'drive-1')).toBe(false);

    mocks.getPrincipalDriveMembership.mockResolvedValue({ role: 'MEMBER', customRoleId: null });
    expect(await canPrincipalRunCodeInDrive(auth, 'drive-1')).toBe(true);
    mocks.getPrincipalDriveMembership.mockResolvedValue({ role: 'ADMIN', customRoleId: 'role-view-only' });
    expect(await canPrincipalRunCodeInDrive(auth, 'drive-1')).toBe(true);
    expect(mocks.getUserDrivePermissions).not.toHaveBeenCalled();
  });

  it('no membership in the drive: no', async () => {
    mocks.isDriveScopedPrincipal.mockReturnValue(false);
    mocks.getPrincipalDriveMembership.mockResolvedValue(null);
    expect(await canPrincipalRunCodeInDrive(auth, 'drive-1')).toBe(false);
    expect(mocks.getUserDrivePermissions).not.toHaveBeenCalled();
  });
});
