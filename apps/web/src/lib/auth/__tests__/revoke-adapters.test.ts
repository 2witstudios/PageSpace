import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockDriveFindFirst, mockMembersSelect } = vi.hoisted(() => ({
  mockDriveFindFirst: vi.fn(),
  mockMembersSelect: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: { drives: { findFirst: mockDriveFindFirst } },
    select: mockMembersSelect,
  },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })) }));
vi.mock('@pagespace/db/schema/core', () => ({ drives: { id: 'drives.id' } }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } },
}));
vi.mock('@/lib/repositories/drive-invite-repository', () => ({
  driveInviteRepository: { findUnconsumedInviteForDrive: vi.fn(), deletePendingInviteForDrive: vi.fn() },
}));
// The org-aware relationship is the decision (its pure role decisions stay real).
vi.mock('@pagespace/lib/permissions/drive-relationship-loader', () => ({
  loadDriveRelationship: vi.fn(),
}));

import { buildRevokePorts } from '../revoke-adapters';
import type { DriveRelationship } from '@pagespace/lib/permissions/drive-relationship';
import { loadDriveRelationship } from '@pagespace/lib/permissions/drive-relationship-loader';

const asMember = (role: 'OWNER' | 'ADMIN' | 'MEMBER', source: 'invite' | 'org' = 'invite'): DriveRelationship => ({
  isOwner: false,
  membership: { role, customRoleId: null, source, auditOrgAdminPrivateAccess: false },
});
const orgDrive = { id: 'drive-1', ownerId: 'lead-1', orgId: 'org-1', orgVisibility: 'OPEN' as const };

const findActorDriveRole = (actorId: string) =>
  buildRevokePorts(new Request('https://example.com')).findActorDriveRole({ driveId: 'drive-1', actorId });

describe('revoke adapters: findActorDriveRole', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDriveFindFirst.mockResolvedValue(orgDrive);
  });

  it('answers null for a drive that does not exist, without resolving anything', async () => {
    mockDriveFindFirst.mockResolvedValue(undefined);
    await expect(findActorDriveRole('user-1')).resolves.toBeNull();
    expect(loadDriveRelationship).not.toHaveBeenCalled();
  });

  it('gives the drive lead OWNER even without an OWNER row (org drives never get one)', async () => {
    vi.mocked(loadDriveRelationship).mockResolvedValue({ isOwner: true, membership: null });
    await expect(findActorDriveRole('lead-1')).resolves.toBe('OWNER');
    expect(loadDriveRelationship).toHaveBeenCalledWith('lead-1', orgDrive);
  });

  it('ORG-4 (partial) an org Admin with no drive_members row revokes as ADMIN', async () => {
    vi.mocked(loadDriveRelationship).mockResolvedValue(asMember('ADMIN'));
    await expect(findActorDriveRole('org-admin-1')).resolves.toBe('ADMIN');
  });

  it('X-6 (partial) a stale source=org ADMIN row answers null, and no drive_members row is read here', async () => {
    vi.mocked(loadDriveRelationship).mockResolvedValue({ isOwner: false, membership: null });
    await expect(findActorDriveRole('user-1')).resolves.toBeNull();
    expect(mockMembersSelect).not.toHaveBeenCalled();
  });

  it('a pending ADMIN invitation answers null (the relationship reads accepted rows only)', async () => {
    vi.mocked(loadDriveRelationship).mockResolvedValue({ isOwner: false, membership: null });
    await expect(findActorDriveRole('pending-admin-1')).resolves.toBeNull();
  });

  it('a personal drive\'s OWNER row still answers OWNER, and a MEMBER answers MEMBER', async () => {
    mockDriveFindFirst.mockResolvedValue({ ...orgDrive, orgId: null });
    vi.mocked(loadDriveRelationship).mockResolvedValueOnce(asMember('OWNER')).mockResolvedValueOnce(asMember('MEMBER'));
    await expect(findActorDriveRole('former-owner-1')).resolves.toBe('OWNER');
    await expect(findActorDriveRole('member-1')).resolves.toBe('MEMBER');
  });
});
