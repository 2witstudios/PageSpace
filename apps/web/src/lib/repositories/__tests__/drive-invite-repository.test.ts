/**
 * Unit tests for driveInviteRepository.
 *
 * The repository is the seam where ORM/query-builder details are isolated, so
 * these tests intentionally mock @pagespace/db/db to verify the seam delegates
 * to Drizzle with the correct shapes (filter clauses, returning(), etc.).
 *
 * Route/service tests must NOT mock db like this — they should mock the
 * repository instead (rubric §3, §4).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSelectChain = vi.hoisted(() => ({ from: vi.fn() }));
const mockInsertChain = vi.hoisted(() => ({ values: vi.fn() }));
const mockUpdateChain = vi.hoisted(() => ({ set: vi.fn() }));
const mockUsersFindFirst = vi.hoisted(() => vi.fn());

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(() => mockSelectChain),
    insert: vi.fn(() => mockInsertChain),
    update: vi.fn(() => mockUpdateChain),
    query: { users: { findFirst: mockUsersFindFirst } },
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field, value) => ({ kind: 'eq', field, value })),
  and: vi.fn((...conditions) => ({ kind: 'and', conditions })),
  isNotNull: vi.fn((field) => ({ kind: 'isNotNull', field })),
}));

vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'users.id', email: 'users.email' },
}));

vi.mock('@pagespace/db/schema/core', () => ({
  drives: { id: 'drives.id' },
  pages: { id: 'pages.id', driveId: 'pages.driveId' },
}));

vi.mock('@pagespace/db/schema/members', () => ({
  driveMembers: {
    id: 'driveMembers.id',
    driveId: 'driveMembers.driveId',
    userId: 'driveMembers.userId',
    role: 'driveMembers.role',
    acceptedAt: 'driveMembers.acceptedAt',
  },
  pagePermissions: {
    id: 'pagePermissions.id',
    pageId: 'pagePermissions.pageId',
    userId: 'pagePermissions.userId',
  },
}));

import { driveInviteRepository } from '../drive-invite-repository';
import { isNotNull } from '@pagespace/db/operators';

const setupSelectLimit = (rows: unknown[]) => {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  mockSelectChain.from = vi.fn().mockReturnValue({ where });
  return { where, limit };
};

const setupSelectAll = (rows: unknown[]) => {
  const where = vi.fn().mockResolvedValue(rows);
  mockSelectChain.from = vi.fn().mockReturnValue({ where });
  return { where };
};

const setupInsert = (rows: unknown[]) => {
  const returning = vi.fn().mockResolvedValue(rows);
  const values = vi.fn().mockReturnValue({ returning });
  mockInsertChain.values = values;
  return { values, returning };
};

const setupUpdate = (returnRows?: unknown[]) => {
  const where = returnRows
    ? vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(returnRows) })
    : vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  mockUpdateChain.set = set;
  return { set, where };
};

beforeEach(() => vi.clearAllMocks());

describe('driveInviteRepository.findDriveById', () => {
  it('returns the drive row when one exists', async () => {
    const drive = { id: 'drive_1', ownerId: 'user_1' };
    const { limit } = setupSelectLimit([drive]);

    expect(await driveInviteRepository.findDriveById('drive_1')).toEqual(drive);
    expect(limit).toHaveBeenCalledWith(1);
  });

  it('returns null when the drive does not exist', async () => {
    setupSelectLimit([]);
    expect(await driveInviteRepository.findDriveById('missing')).toBeNull();
  });
});

describe('driveInviteRepository.findAdminMembership', () => {
  it('applies the acceptedAt-IS-NOT-NULL gate so pending ADMINs are excluded', async () => {
    const member = { id: 'mem_1', role: 'ADMIN', acceptedAt: new Date('2025-01-01') };
    const { where } = setupSelectLimit([member]);

    const result = await driveInviteRepository.findAdminMembership('drive_1', 'user_1');

    expect(result).toEqual(member);
    expect(isNotNull).toHaveBeenCalledWith('driveMembers.acceptedAt');
    const args = where.mock.calls[0]?.[0] as { conditions?: unknown[] };
    expect(args?.conditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'isNotNull', field: 'driveMembers.acceptedAt' }),
      ])
    );
  });

  it('returns null when no accepted ADMIN row matches (pending or non-ADMIN)', async () => {
    setupSelectLimit([]);
    expect(await driveInviteRepository.findAdminMembership('drive_1', 'user_1')).toBeNull();
  });
});

describe('driveInviteRepository.findExistingMember', () => {
  it('returns any matching membership without filtering on acceptedAt', async () => {
    const pending = { id: 'mem_pending', role: 'MEMBER', acceptedAt: null };
    const { where } = setupSelectLimit([pending]);

    expect(await driveInviteRepository.findExistingMember('drive_1', 'user_1')).toEqual(pending);
    expect(isNotNull).not.toHaveBeenCalled();
    const args = where.mock.calls[0]?.[0] as { conditions?: unknown[] };
    const hasIsNotNull = (args?.conditions ?? []).some(
      (c) => (c as { kind?: string }).kind === 'isNotNull'
    );
    expect(hasIsNotNull).toBe(false);
  });

  it('returns null when no membership exists', async () => {
    setupSelectLimit([]);
    expect(await driveInviteRepository.findExistingMember('drive_1', 'nobody')).toBeNull();
  });
});

describe('driveInviteRepository.createDriveMember', () => {
  const baseInput = {
    driveId: 'drive_1',
    userId: 'user_1',
    role: 'MEMBER' as const,
    customRoleId: null,
    invitedBy: 'inviter',
  };

  it('persists acceptedAt as a Date when provided (auto-accept path)', async () => {
    const acceptedAt = new Date('2025-02-01');
    const inserted = { id: 'mem_new', ...baseInput, acceptedAt };
    const { values } = setupInsert([inserted]);

    const result = await driveInviteRepository.createDriveMember({ ...baseInput, acceptedAt });

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ acceptedAt }));
    expect(result.acceptedAt).toEqual(acceptedAt);
  });

  it('persists acceptedAt as null for pending invitations', async () => {
    const inserted = { id: 'mem_pending', ...baseInput, acceptedAt: null };
    const { values } = setupInsert([inserted]);

    const result = await driveInviteRepository.createDriveMember({ ...baseInput, acceptedAt: null });

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ acceptedAt: null }));
    expect(result.acceptedAt).toBeNull();
  });
});

describe('driveInviteRepository.updateDriveMemberRole', () => {
  it('updates role and customRoleId for the given memberId', async () => {
    const { set } = setupUpdate();

    await driveInviteRepository.updateDriveMemberRole('mem_1', 'ADMIN', 'role_x');

    expect(set).toHaveBeenCalledWith({ role: 'ADMIN', customRoleId: 'role_x' });
  });
});

describe('driveInviteRepository.getValidPageIds', () => {
  it('returns the page ids belonging to the drive', async () => {
    setupSelectAll([{ id: 'page_1' }, { id: 'page_2' }]);
    expect(await driveInviteRepository.getValidPageIds('drive_1')).toEqual(['page_1', 'page_2']);
  });

  it('returns an empty array when the drive has no pages', async () => {
    setupSelectAll([]);
    expect(await driveInviteRepository.getValidPageIds('drive_empty')).toEqual([]);
  });
});

describe('driveInviteRepository.findPagePermission', () => {
  it('returns the permission row when one exists, null otherwise', async () => {
    const perm = { id: 'perm_1', canView: true };
    setupSelectLimit([perm]);
    expect(await driveInviteRepository.findPagePermission('page_1', 'user_1')).toEqual(perm);

    setupSelectLimit([]);
    expect(await driveInviteRepository.findPagePermission('page_1', 'user_1')).toBeNull();
  });
});

describe('driveInviteRepository.createPagePermission', () => {
  it('inserts the permission and returns the inserted row', async () => {
    const data = {
      pageId: 'page_1',
      userId: 'user_1',
      canView: true,
      canEdit: false,
      canShare: false,
      canDelete: false,
      grantedBy: 'inviter',
    };
    const { values } = setupInsert([{ id: 'perm_new', ...data }]);

    const result = await driveInviteRepository.createPagePermission(data);

    expect(values).toHaveBeenCalledWith(expect.objectContaining(data));
    expect(result).toMatchObject(data);
  });
});

describe('driveInviteRepository.updatePagePermission', () => {
  it('updates the permission row and returns the updated row', async () => {
    const grantedAt = new Date('2025-02-01');
    const data = { canView: true, canEdit: true, canShare: false, grantedBy: 'inviter', grantedAt };
    const updated = { id: 'perm_1', ...data };
    const { set } = setupUpdate([updated]);

    expect(await driveInviteRepository.updatePagePermission('perm_1', data)).toEqual(updated);
    expect(set).toHaveBeenCalledWith(expect.objectContaining(data));
  });
});

describe('driveInviteRepository.findUserEmail', () => {
  it('returns the user email when found, undefined otherwise', async () => {
    mockUsersFindFirst.mockResolvedValueOnce({ email: 'jane@example.com' });
    expect(await driveInviteRepository.findUserEmail('user_1')).toBe('jane@example.com');

    mockUsersFindFirst.mockResolvedValueOnce(undefined);
    expect(await driveInviteRepository.findUserEmail('missing')).toBeUndefined();
  });
});
