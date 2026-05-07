import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: { select: vi.fn() },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', driveId: 'driveId' },
  drives: { id: 'id', ownerId: 'ownerId' },
}));
vi.mock('@pagespace/db/schema/members', () => ({
  driveMembers: {
    id: 'id',
    driveId: 'driveId',
    userId: 'userId',
    role: 'role',
    acceptedAt: 'acceptedAt',
  },
  pagePermissions: {
    id: 'id',
    pageId: 'pageId',
    userId: 'userId',
    canView: 'canView',
    expiresAt: 'expiresAt',
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  isNull: vi.fn(),
  isNotNull: vi.fn((a: unknown) => ({ isNotNull: a })),
  gt: vi.fn(),
  inArray: vi.fn((a: unknown, b: unknown) => ({ inArray: { a, b } })),
}));

vi.mock('../../logging/logger-config', () => ({
  loggers: {
    api: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  },
}));

vi.mock('../../validators', () => ({
  parseUserId: vi.fn(),
  parsePageId: vi.fn(),
}));

import { usersShareDrive } from '../permissions';
import { db } from '@pagespace/db/db';
import { loggers } from '../../logging/logger-config';

const A = 'user_a';
const B = 'user_b';

function stubFromWhere(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  } as unknown as ReturnType<typeof db.select>;
}

function stubFromWhereLimit(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as unknown as ReturnType<typeof db.select>;
}

describe('usersShareDrive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false when both ids are the same user', async () => {
    expect(await usersShareDrive(A, A)).toBe(false);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('returns false when user A has neither owned nor any-member drives', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubFromWhere([])) // owned by A
      .mockReturnValueOnce(stubFromWhere([])); // member rows for A

    expect(await usersShareDrive(A, B)).toBe(false);
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it('returns true when both users are members of the same drive', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubFromWhere([])) // A owns nothing
      .mockReturnValueOnce(stubFromWhere([{ driveId: 'drive_1' }])) // A is member
      .mockReturnValueOnce(stubFromWhereLimit([])) // B does not own a drive in A's set
      .mockReturnValueOnce(stubFromWhereLimit([{ id: 'mem_b' }])); // B is member

    expect(await usersShareDrive(A, B)).toBe(true);
  });

  it('returns true when A owns a drive that B is a member of', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubFromWhere([{ id: 'drive_1' }])) // A owns drive_1
      .mockReturnValueOnce(stubFromWhere([])) // A has no member rows
      .mockReturnValueOnce(stubFromWhereLimit([])) // B is not owner of drive_1
      .mockReturnValueOnce(stubFromWhereLimit([{ id: 'mem_b' }])); // B is member of drive_1

    expect(await usersShareDrive(A, B)).toBe(true);
  });

  it('returns true when B owns a drive that A is a member of', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubFromWhere([])) // A owns nothing
      .mockReturnValueOnce(stubFromWhere([{ driveId: 'drive_1' }])) // A is member of drive_1
      .mockReturnValueOnce(stubFromWhereLimit([{ id: 'drive_1' }])); // B is owner of drive_1 — short-circuits

    expect(await usersShareDrive(A, B)).toBe(true);
  });

  it('returns true even when membership rows lack acceptedAt (legacy data)', async () => {
    // Defensive: a driveMembers row whose acceptedAt is NULL (e.g., a legacy
    // pending row not yet cleaned up by migrate-pending-invites) still counts
    // as drive co-membership for DM purposes.
    vi.mocked(db.select)
      .mockReturnValueOnce(stubFromWhere([])) // A owns nothing
      .mockReturnValueOnce(stubFromWhere([{ driveId: 'drive_1' }])) // A row exists, acceptedAt may be NULL
      .mockReturnValueOnce(stubFromWhereLimit([])) // B not owner
      .mockReturnValueOnce(stubFromWhereLimit([{ id: 'mem_b' }])); // B row exists, acceptedAt may be NULL

    expect(await usersShareDrive(A, B)).toBe(true);
  });

  it('returns false when A has drives but B has no overlap (neither owner nor member)', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubFromWhere([{ id: 'drive_a' }])) // A owns drive_a
      .mockReturnValueOnce(stubFromWhere([])) // no A member rows
      .mockReturnValueOnce(stubFromWhereLimit([])) // B not owner
      .mockReturnValueOnce(stubFromWhereLimit([])); // B not member

    expect(await usersShareDrive(A, B)).toBe(false);
  });

  it('fails closed and logs on a DB error', async () => {
    vi.mocked(db.select).mockImplementationOnce(() => {
      throw new Error('DB down');
    });

    expect(await usersShareDrive(A, B)).toBe(false);
    expect(loggers.api.error).toHaveBeenCalledWith(
      '[USERS_SHARE_DRIVE] Error checking shared drive membership',
      expect.objectContaining({ userIdA: A, userIdB: B })
    );
  });
});
