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
  isNull: vi.fn((field) => ({ kind: 'isNull', field })),
}));

vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'users.id', email: 'users.email' },
}));

vi.mock('@pagespace/db/schema/core', () => ({
  drives: { id: 'drives.id', name: 'drives.name' },
  pages: { id: 'pages.id', driveId: 'pages.driveId' },
}));

vi.mock('@pagespace/db/schema/members', () => ({
  driveMembers: {
    id: 'driveMembers.id',
    driveId: 'driveMembers.driveId',
    userId: 'driveMembers.userId',
    role: 'driveMembers.role',
    acceptedAt: 'driveMembers.acceptedAt',
    invitedAt: 'driveMembers.invitedAt',
  },
  pagePermissions: {
    id: 'pagePermissions.id',
    pageId: 'pagePermissions.pageId',
    userId: 'pagePermissions.userId',
  },
}));

import { driveInviteRepository } from '../drive-invite-repository';
import { isNotNull, isNull } from '@pagespace/db/operators';

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

describe('driveInviteRepository.findPendingMembersForUser', () => {
  const setupSelectJoinWhere = (rows: unknown[]) => {
    const where = vi.fn().mockResolvedValue(rows);
    const innerJoin = vi.fn().mockReturnValue({ where });
    mockSelectChain.from = vi.fn().mockReturnValue({ innerJoin });
    return { innerJoin, where };
  };

  it('given a user with two pending rows across two drives, returns both with drive names joined in', async () => {
    const rows = [
      { id: 'mem_a', driveId: 'drive_a', role: 'MEMBER', driveName: 'Alpha' },
      { id: 'mem_b', driveId: 'drive_b', role: 'ADMIN', driveName: 'Beta' },
    ];
    const { where } = setupSelectJoinWhere(rows);

    const result = await driveInviteRepository.findPendingMembersForUser('user_1');

    expect(result).toEqual(rows);
    expect(isNull).toHaveBeenCalledWith('driveMembers.acceptedAt');
    const args = where.mock.calls[0]?.[0] as { conditions?: unknown[] };
    expect(args?.conditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'eq', field: 'driveMembers.userId', value: 'user_1' }),
        expect.objectContaining({ kind: 'isNull', field: 'driveMembers.acceptedAt' }),
      ])
    );
  });

  it('given a user with no pending rows, returns an empty array', async () => {
    setupSelectJoinWhere([]);
    expect(await driveInviteRepository.findPendingMembersForUser('user_1')).toEqual([]);
  });

  it('given a user with both pending and accepted rows, the isNull(acceptedAt) clause filters to only pending', async () => {
    const pendingOnly = [{ id: 'mem_p', driveId: 'drive_p', role: 'MEMBER', driveName: 'Pending' }];
    const { where } = setupSelectJoinWhere(pendingOnly);

    const result = await driveInviteRepository.findPendingMembersForUser('user_1');

    expect(result).toEqual(pendingOnly);
    const args = where.mock.calls[0]?.[0] as { conditions?: unknown[] };
    const hasIsNull = (args?.conditions ?? []).some(
      (c) => (c as { kind?: string }).kind === 'isNull'
    );
    expect(hasIsNull).toBe(true);
  });
});

describe('driveInviteRepository.acceptPendingMember', () => {
  const setupConditionalUpdate = (returnRows: { id: string }[]) => {
    const returning = vi.fn().mockResolvedValue(returnRows);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    mockUpdateChain.set = set;
    return { set, where, returning };
  };

  it('given a member id where acceptedAt IS NULL, sets acceptedAt and returns true', async () => {
    const { set, where } = setupConditionalUpdate([{ id: 'mem_1' }]);

    const result = await driveInviteRepository.acceptPendingMember('mem_1');

    expect(result).toBe(true);
    const setArg = set.mock.calls[0]?.[0] as { acceptedAt?: Date };
    expect(setArg?.acceptedAt).toBeInstanceOf(Date);
    expect(isNull).toHaveBeenCalledWith('driveMembers.acceptedAt');
    const whereArg = where.mock.calls[0]?.[0] as { conditions?: unknown[] };
    expect(whereArg?.conditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'eq', field: 'driveMembers.id', value: 'mem_1' }),
        expect.objectContaining({ kind: 'isNull', field: 'driveMembers.acceptedAt' }),
      ])
    );
  });

  it('given a concurrent acceptance has already set acceptedAt, the conditional UPDATE matches zero rows and returns false', async () => {
    setupConditionalUpdate([]);
    expect(await driveInviteRepository.acceptPendingMember('mem_already_accepted')).toBe(false);
  });
});

describe('driveInviteRepository.bumpInvitedAt', () => {
  // REVIEW: confirm overwrite acceptable for compliance.
  // bumpInvitedAt overwrites the original invitedAt rather than persisting a
  // separate lastInvitedAt column. The product requirement is "last sent N
  // minutes ago" which only needs the most recent send time. If audit/legal
  // ever needs the original-invite timestamp, add a lastInvitedAt column and
  // stop overwriting. PR #1229 review flagged this as the simpler path.
  it('given a member id, sets invitedAt to a fresh Date filtered by the member id (scoped, not mass)', async () => {
    const { set, where } = setupUpdate();

    await driveInviteRepository.bumpInvitedAt('mem_1');

    const setArg = set.mock.calls[0]?.[0] as { invitedAt?: Date };
    expect(setArg?.invitedAt).toBeInstanceOf(Date);
    // Guard against accidental mass-update: WHERE must scope to this id.
    expect(where).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'eq', field: 'driveMembers.id', value: 'mem_1' })
    );
  });
});
