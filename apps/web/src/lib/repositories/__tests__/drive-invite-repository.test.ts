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
const mockDeleteChain = vi.hoisted(() => ({ where: vi.fn() }));
const mockUsersFindFirst = vi.hoisted(() => vi.fn());
const mockTransaction = vi.hoisted(() => vi.fn());

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(() => mockSelectChain),
    insert: vi.fn(() => mockInsertChain),
    update: vi.fn(() => mockUpdateChain),
    delete: vi.fn(() => mockDeleteChain),
    transaction: mockTransaction,
    query: { users: { findFirst: mockUsersFindFirst } },
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field, value) => ({ kind: 'eq', field, value })),
  and: vi.fn((...conditions) => ({ kind: 'and', conditions })),
  or: vi.fn((...conditions) => ({ kind: 'or', conditions })),
  gt: vi.fn((field, value) => ({ kind: 'gt', field, value })),
  lte: vi.fn((field, value) => ({ kind: 'lte', field, value })),
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

vi.mock('@pagespace/db/schema/pending-invites', () => ({
  pendingInvites: {
    id: 'pendingInvites.id',
    tokenHash: 'pendingInvites.tokenHash',
    email: 'pendingInvites.email',
    driveId: 'pendingInvites.driveId',
    role: 'pendingInvites.role',
    invitedBy: 'pendingInvites.invitedBy',
    expiresAt: 'pendingInvites.expiresAt',
    consumedAt: 'pendingInvites.consumedAt',
    createdAt: 'pendingInvites.createdAt',
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

describe('driveInviteRepository.findPendingInviteByTokenHash', () => {
  const setupSelectJoinJoinLimit = (rows: unknown[]) => {
    const limit = vi.fn().mockResolvedValue(rows);
    const where = vi.fn().mockReturnValue({ limit });
    const innerJoin2 = vi.fn().mockReturnValue({ where });
    const innerJoin1 = vi.fn().mockReturnValue({ innerJoin: innerJoin2 });
    mockSelectChain.from = vi.fn().mockReturnValue({ innerJoin: innerJoin1 });
    return { innerJoin1, innerJoin2, where, limit };
  };

  it('given a tokenHash that matches an active row, returns the joined drive name + inviter name', async () => {
    const row = {
      id: 'inv_1',
      email: 'invitee@example.com',
      driveId: 'drive_1',
      role: 'MEMBER',
      invitedBy: 'inviter_1',
      expiresAt: new Date('2030-01-01'),
      consumedAt: null,
      driveName: 'Alpha',
      inviterName: 'Jane',
    };
    setupSelectJoinJoinLimit([row]);

    const result = await driveInviteRepository.findPendingInviteByTokenHash('hash_xyz');

    expect(result).toEqual(row);
  });

  it('given a tokenHash that does not match any row, returns null', async () => {
    setupSelectJoinJoinLimit([]);
    expect(await driveInviteRepository.findPendingInviteByTokenHash('missing')).toBeNull();
  });
});

describe('driveInviteRepository.findActivePendingInviteByDriveAndEmail', () => {
  const setupSelectLimitWhere = (rows: unknown[]) => {
    const limit = vi.fn().mockResolvedValue(rows);
    const where = vi.fn().mockReturnValue({ limit });
    mockSelectChain.from = vi.fn().mockReturnValue({ where });
    return { where, limit };
  };

  it('given an unconsumed unexpired row, returns it (filtered by drive + email + consumedAt IS NULL + expiresAt > now)', async () => {
    const now = new Date('2026-05-06T12:00:00.000Z');
    const row = { id: 'inv_active' };
    const { where } = setupSelectLimitWhere([row]);

    expect(
      await driveInviteRepository.findActivePendingInviteByDriveAndEmail('drive_1', 'a@b.com', now)
    ).toEqual(row);

    expect(isNull).toHaveBeenCalledWith('pendingInvites.consumedAt');
    const args = where.mock.calls[0]?.[0] as { conditions?: unknown[] };
    expect(args?.conditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'eq', field: 'pendingInvites.driveId', value: 'drive_1' }),
        expect.objectContaining({ kind: 'eq', field: 'pendingInvites.email', value: 'a@b.com' }),
        expect.objectContaining({ kind: 'isNull', field: 'pendingInvites.consumedAt' }),
        // null expiresAt = no expiry; otherwise require expiresAt > now
        expect.objectContaining({
          kind: 'or',
          conditions: expect.arrayContaining([
            expect.objectContaining({ kind: 'isNull', field: 'pendingInvites.expiresAt' }),
            expect.objectContaining({ kind: 'gt', field: 'pendingInvites.expiresAt', value: now }),
          ]),
        }),
      ])
    );
  });

  it('given no active row exists (expired-unconsumed rows must NOT be returned), returns null', async () => {
    setupSelectLimitWhere([]);
    expect(
      await driveInviteRepository.findActivePendingInviteByDriveAndEmail(
        'drive_1',
        'a@b.com',
        new Date()
      )
    ).toBeNull();
  });
});

describe('driveInviteRepository.markInviteConsumed', () => {
  const setupConditionalUpdate = (returnRows: { id: string }[]) => {
    const returning = vi.fn().mockResolvedValue(returnRows);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    mockUpdateChain.set = set;
    return { set, where };
  };

  it('given an unconsumed invite, sets consumedAt to now and returns true', async () => {
    const now = new Date('2026-05-06T12:00:00.000Z');
    const { set, where } = setupConditionalUpdate([{ id: 'inv_1' }]);

    expect(await driveInviteRepository.markInviteConsumed({ inviteId: 'inv_1', now })).toBe(true);
    expect(set).toHaveBeenCalledWith({ consumedAt: now });
    expect(isNull).toHaveBeenCalledWith('pendingInvites.consumedAt');
    const whereArg = where.mock.calls[0]?.[0] as { conditions?: unknown[] };
    expect(whereArg?.conditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'eq', field: 'pendingInvites.id', value: 'inv_1' }),
        expect.objectContaining({ kind: 'isNull', field: 'pendingInvites.consumedAt' }),
      ])
    );
  });

  it('given a concurrent consume already happened, returns false (zero rows updated)', async () => {
    setupConditionalUpdate([]);
    expect(
      await driveInviteRepository.markInviteConsumed({ inviteId: 'inv_done', now: new Date() })
    ).toBe(false);
  });
});

describe('driveInviteRepository.deletePendingInvite', () => {
  it('given an invite id, deletes the row scoped by id', async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    mockDeleteChain.where = where;

    await driveInviteRepository.deletePendingInvite('inv_1');

    expect(where).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'eq', field: 'pendingInvites.id', value: 'inv_1' })
    );
  });
});

describe('driveInviteRepository.loadUserAccountByEmail', () => {
  it('given an email that maps to an active user, returns id + suspendedAt null', async () => {
    mockUsersFindFirst.mockResolvedValueOnce({ id: 'user_1', suspendedAt: null });
    expect(await driveInviteRepository.loadUserAccountByEmail('A@B.com')).toEqual({
      id: 'user_1',
      suspendedAt: null,
    });
  });

  it('given an email that maps to a suspended user, returns id + the suspendedAt timestamp', async () => {
    const suspendedAt = new Date('2026-04-01');
    mockUsersFindFirst.mockResolvedValueOnce({ id: 'user_susp', suspendedAt });
    expect(await driveInviteRepository.loadUserAccountByEmail('a@b.com')).toEqual({
      id: 'user_susp',
      suspendedAt,
    });
  });

  it('given an unknown email, returns null', async () => {
    mockUsersFindFirst.mockResolvedValueOnce(undefined);
    expect(await driveInviteRepository.loadUserAccountByEmail('nobody@nowhere.com')).toBeNull();
  });
});

describe('driveInviteRepository.createPendingInvite', () => {
  // Wires db.transaction(callback) to invoke the callback with a tx mock and
  // return its resolved value, mirroring Drizzle's runtime behavior.
  const setupTxInsertSweep = (insertedRow: unknown) => {
    const txDeleteWhere = vi.fn().mockResolvedValue(undefined);
    const txDelete = vi.fn().mockReturnValue({ where: txDeleteWhere });
    const txInsertReturning = vi.fn().mockResolvedValue([insertedRow]);
    const txInsertValues = vi.fn().mockReturnValue({ returning: txInsertReturning });
    const txInsert = vi.fn().mockReturnValue({ values: txInsertValues });

    mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = { delete: txDelete, insert: txInsert };
      return cb(tx);
    });

    return { txDeleteWhere, txInsertValues, txInsertReturning };
  };

  it('given a fresh insert input, sweeps expired-unconsumed rows for (driveId, email) then inserts the new row', async () => {
    const inserted = { id: 'inv_new' };
    const { txDeleteWhere, txInsertValues } = setupTxInsertSweep(inserted);
    const expiresAt = new Date('2030-01-01');
    const now = new Date('2026-05-06T12:00:00.000Z');

    const result = await driveInviteRepository.createPendingInvite({
      tokenHash: 'h1',
      email: 'a@b.com',
      driveId: 'drive_1',
      role: 'MEMBER',
      customRoleId: null,
      invitedBy: 'inviter_1',
      expiresAt,
      now,
    });

    expect(result).toEqual(inserted);
    expect(txInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenHash: 'h1',
        email: 'a@b.com',
        driveId: 'drive_1',
        role: 'MEMBER',
        invitedBy: 'inviter_1',
        expiresAt,
      })
    );
    // The sweep deletes expired-unconsumed rows for the (driveId, email) pair.
    expect(txDeleteWhere).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'and',
        conditions: expect.arrayContaining([
          expect.objectContaining({ kind: 'eq', field: 'pendingInvites.driveId', value: 'drive_1' }),
          expect.objectContaining({ kind: 'eq', field: 'pendingInvites.email', value: 'a@b.com' }),
          expect.objectContaining({ kind: 'isNull', field: 'pendingInvites.consumedAt' }),
          expect.objectContaining({ kind: 'lte', field: 'pendingInvites.expiresAt', value: now }),
        ]),
      })
    );
  });
});

describe('driveInviteRepository.consumeInviteAndCreateMembership', () => {
  const setupTx = ({
    consumeReturning,
    insertReturning,
    insertThrows,
  }: {
    consumeReturning: { id: string }[];
    insertReturning?: { id: string }[];
    insertThrows?: Error;
  }) => {
    const txUpdateReturning = vi.fn().mockResolvedValue(consumeReturning);
    const txUpdateWhere = vi.fn().mockReturnValue({ returning: txUpdateReturning });
    const txUpdateSet = vi.fn().mockReturnValue({ where: txUpdateWhere });
    const txUpdate = vi.fn().mockReturnValue({ set: txUpdateSet });

    const txInsertReturning = insertThrows
      ? vi.fn().mockRejectedValue(insertThrows)
      : vi.fn().mockResolvedValue(insertReturning ?? []);
    const txInsertValues = vi.fn().mockReturnValue({ returning: txInsertReturning });
    const txInsert = vi.fn().mockReturnValue({ values: txInsertValues });

    mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = { update: txUpdate, insert: txInsert };
      return cb(tx);
    });

    return { txUpdateSet, txUpdateWhere, txInsertValues };
  };

  const baseInput = {
    inviteId: 'inv_1',
    driveId: 'drive_1',
    userId: 'user_new',
    role: 'MEMBER' as const,
    customRoleId: null,
    invitedBy: 'inviter_1',
    acceptedAt: new Date('2026-05-06T12:00:00.000Z'),
  };

  it('given an unconsumed invite, atomically consumes it and inserts the drive_members row, returns ok + memberId', async () => {
    const { txUpdateSet, txInsertValues } = setupTx({
      consumeReturning: [{ id: 'inv_1' }],
      insertReturning: [{ id: 'mem_new' }],
    });

    const result = await driveInviteRepository.consumeInviteAndCreateMembership(baseInput);

    expect(result).toEqual({ ok: true, memberId: 'mem_new' });
    const setArg = txUpdateSet.mock.calls[0]?.[0] as { consumedAt?: Date };
    expect(setArg?.consumedAt).toEqual(baseInput.acceptedAt);
    expect(txInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        driveId: 'drive_1',
        userId: 'user_new',
        role: 'MEMBER',
        invitedBy: 'inviter_1',
        acceptedAt: baseInput.acceptedAt,
      })
    );
  });

  it('given the conditional consume matches zero rows (already consumed), returns ok=false reason=TOKEN_CONSUMED and skips the insert', async () => {
    const { txInsertValues } = setupTx({ consumeReturning: [] });

    const result = await driveInviteRepository.consumeInviteAndCreateMembership(baseInput);

    expect(result).toEqual({ ok: false, reason: 'TOKEN_CONSUMED' });
    expect(txInsertValues).not.toHaveBeenCalled();
  });

  it('given the drive_members insert throws on a unique-violation (unique drive_user_key), returns ok=false reason=ALREADY_MEMBER', async () => {
    const uniqueViolation = new Error('duplicate key value violates unique constraint "drive_members_drive_user_key"');
    setupTx({ consumeReturning: [{ id: 'inv_1' }], insertThrows: uniqueViolation });

    const result = await driveInviteRepository.consumeInviteAndCreateMembership(baseInput);

    expect(result).toEqual({ ok: false, reason: 'ALREADY_MEMBER' });
  });

  it('given a non-unique-violation error, propagates so the caller can 500 (transaction rollback handles consume)', async () => {
    const otherError = new Error('connection lost');
    setupTx({ consumeReturning: [{ id: 'inv_1' }], insertThrows: otherError });

    await expect(
      driveInviteRepository.consumeInviteAndCreateMembership(baseInput)
    ).rejects.toThrow('connection lost');
  });
});

