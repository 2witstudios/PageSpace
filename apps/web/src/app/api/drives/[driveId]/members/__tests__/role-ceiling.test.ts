/**
 * Pending drive invites are shown to owners/admins only. The member listing
 * decided that with the credential's role alone, so a user demoted ADMIN→MEMBER
 * kept seeing pending invites through an ADMIN key. Owner/admin now needs the
 * credential AND its user (point-guard members/roles ruling; OAuth is denied
 * here by [D-14 interim]).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  checkDriveAccess: vi.fn(),
  listDriveMembers: vi.fn(async () => []),
  getDriveOwnerAsMember: vi.fn(async () => null),
}));
vi.mock('@/lib/repositories/drive-invite-repository', () => ({
  driveInviteRepository: { findUnconsumedInvitesByDrive: vi.fn(async () => [{ id: 'invite-1' }]) },
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  logSecurityEvent: vi.fn(),
}));
vi.mock('@pagespace/lib/permissions/app-permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/permissions/app-permissions')>()),
  getAppDriveMembership: vi.fn(),
}));
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, authenticateRequestWithOptions: vi.fn() };
});

import { GET } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { checkDriveAccess } from '@pagespace/lib/services/drive-member-service';
import { getAppDriveMembership } from '@pagespace/lib/permissions/app-permissions';
import { PARITY_USER_ID, mcpDriveKey } from '@/lib/auth/__tests__/oauth-principal-fixture';

const list = () => GET(new Request('https://example.com/api/drives/drivex/members'), { params: Promise.resolve({ driveId: 'drivex' }) });
const userIs = (admin: boolean) =>
  vi.mocked(checkDriveAccess).mockResolvedValue({ isOwner: false, isAdmin: admin, isMember: true, drive: { id: 'drivex' } } as never);

beforeEach(() => vi.clearAllMocks());

describe('GET /api/drives/[driveId]/members — pending invites need the credential AND its user', () => {
  it('hides pending invites from an ADMIN-role mcp_ key whose user is no longer an admin', async () => {
    vi.mocked(getAppDriveMembership).mockResolvedValue({ role: 'ADMIN', customRoleId: null, ownerUserId: PARITY_USER_ID });
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mcpDriveKey('drivex'));
    userIs(false);
    const res = await list();
    expect(res.status).toBe(200);
    expect((await res.json()).pendingInvites).toEqual([]);
  });

  it('hides them from a MEMBER-role key held by an admin, and shows them to an ADMIN key of a current admin', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mcpDriveKey('drivex'));
    userIs(true);
    vi.mocked(getAppDriveMembership).mockResolvedValue({ role: 'MEMBER', customRoleId: null, ownerUserId: PARITY_USER_ID });
    expect((await (await list()).json()).pendingInvites).toEqual([]);
    vi.mocked(getAppDriveMembership).mockResolvedValue({ role: 'ADMIN', customRoleId: null, ownerUserId: PARITY_USER_ID });
    expect((await (await list()).json()).pendingInvites).toEqual([{ id: 'invite-1' }]);
  });
});
