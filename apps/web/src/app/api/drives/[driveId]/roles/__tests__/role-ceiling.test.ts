/**
 * Role-ceiling escape fixed for every principal that reaches roles (point-guard
 * ruling; OAuth stays denied here by [D-14 interim]): creating, updating or
 * deleting a drive role asked only whether the USER is owner/admin, so a
 * MEMBER-role mcp_ key held by an admin could redefine what roles grant — and
 * with it mint admin-level authority for someone else. Owner/admin authority
 * now requires BOTH the credential's role and the user's current role.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/services/drive-role-service', () => ({
  checkDriveAccessForRoles: vi.fn(),
  listDriveRoles: vi.fn(async () => []),
  createDriveRole: vi.fn(async () => ({ id: 'role-new', name: 'Editors' })),
  validateRolePermissions: vi.fn(() => true),
  validateDriveWidePermissions: vi.fn(() => true),
  validateRolePermissionsPatch: vi.fn(() => true),
  getRoleById: vi.fn(async () => ({ id: 'role-1', name: 'Editors', permissions: {} })),
  roleNotFoundMessage: vi.fn(() => 'Role not found'),
  updateDriveRole: vi.fn(async () => ({ role: { id: 'role-1', name: 'Editors', permissions: {} } })),
  deleteDriveRole: vi.fn(async () => undefined),
}));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({ getActorInfo: vi.fn(async () => ({})), logRoleActivity: vi.fn() }));
vi.mock('@pagespace/lib/services/drive-member-service', () => ({ getDriveRecipientUserIds: vi.fn(async () => []) }));
vi.mock('@/lib/websocket', () => ({ broadcastDriveEvent: vi.fn(async () => undefined), createDriveEventPayload: vi.fn() }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/permissions/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/permissions/permissions')>()),
  isDriveOwnerOrAdmin: vi.fn(async () => true),
}));
vi.mock('@pagespace/lib/permissions/app-permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/permissions/app-permissions')>()),
  getAppDriveMembership: vi.fn(),
}));
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, authenticateRequestWithOptions: vi.fn() };
});

import { POST } from '../route';
import { PATCH, DELETE } from '../[roleId]/route';
import { authenticateRequestWithOptions, type AuthResult } from '@/lib/auth';
import { checkDriveAccessForRoles, createDriveRole, updateDriveRole, deleteDriveRole } from '@pagespace/lib/services/drive-role-service';
import { getAppDriveMembership } from '@pagespace/lib/permissions/app-permissions';
import { PARITY_USER_ID, mcpDriveKey } from '@/lib/auth/__tests__/oauth-principal-fixture';

const DRIVE = 'drivex';
const session: AuthResult = { tokenType: 'session', sessionId: 's', userId: PARITY_USER_ID, role: 'user', tokenVersion: 0, adminRoleVersion: 0 };
const params = { params: Promise.resolve({ driveId: DRIVE }) };
const roleParams = { params: Promise.resolve({ driveId: DRIVE, roleId: 'role-1' }) };

const create = () => POST(new Request('https://example.com/api/drives/drivex/roles', { method: 'POST', body: JSON.stringify({ name: 'Editors', permissions: {} }) }), params);
const update = () => PATCH(new Request('https://example.com/api/drives/drivex/roles/role-1', { method: 'PATCH', body: JSON.stringify({ name: 'Admins-ish' }) }), roleParams);
const remove = () => DELETE(new Request('https://example.com/api/drives/drivex/roles/role-1', { method: 'DELETE' }), roleParams);

const keyWithRole = (role: 'MEMBER' | 'ADMIN') => {
  vi.mocked(getAppDriveMembership).mockResolvedValue({ role, customRoleId: null, ownerUserId: PARITY_USER_ID });
  return mcpDriveKey(DRIVE);
};
const userIs = (admin: boolean) =>
  vi.mocked(checkDriveAccessForRoles).mockResolvedValue({ isOwner: false, isAdmin: admin, isMember: true, drive: { id: DRIVE, ownerId: 'owner' } } as never);

beforeEach(() => vi.clearAllMocks());

describe('drive roles — owner/admin needs the credential AND its user', () => {
  it("refuses a MEMBER-role mcp_ key held by an admin creating, updating or deleting roles", async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(keyWithRole('MEMBER'));
    userIs(true);
    expect((await create()).status).toBe(403);
    expect((await update()).status).toBe(403);
    expect((await remove()).status).toBe(403);
    expect(createDriveRole).not.toHaveBeenCalled();
    expect(updateDriveRole).not.toHaveBeenCalled();
    expect(deleteDriveRole).not.toHaveBeenCalled();
  });

  it('refuses an ADMIN-role mcp_ key whose user is no longer an admin', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(keyWithRole('ADMIN'));
    userIs(false);
    expect((await create()).status).toBe(403);
    expect(createDriveRole).not.toHaveBeenCalled();
  });

  it('admits an ADMIN-role mcp_ key of a current admin', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(keyWithRole('ADMIN'));
    userIs(true);
    expect((await create()).status).toBeLessThan(300);
    expect((await update()).status).toBe(200);
    expect((await remove()).status).toBe(200);
  });

  it('leaves a session admin unchanged', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session);
    userIs(true);
    expect((await create()).status).toBeLessThan(300);
    expect((await remove()).status).toBe(200);
  });
});
