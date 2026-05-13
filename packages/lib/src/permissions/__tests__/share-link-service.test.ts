import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks (must be declared before imports)
// ---------------------------------------------------------------------------

const { mockDb } = vi.hoisted(() => {
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  };
  return { mockDb };
});

vi.mock('@pagespace/db/db', () => ({ db: mockDb }));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a, b) => ({ op: 'eq', a, b })),
  and: vi.fn((...args) => ({ op: 'and', args })),
  or: vi.fn((...args) => ({ op: 'or', args })),
  isNull: vi.fn((a) => ({ op: 'isNull', a })),
  gt: vi.fn((a, b) => ({ op: 'gt', a, b })),
  isNotNull: vi.fn((a) => ({ op: 'isNotNull', a })),
  sql: vi.fn((s) => s),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  drives: { id: 'drives.id', ownerId: 'drives.ownerId', name: 'drives.name' },
  pages: { id: 'pages.id', driveId: 'pages.driveId', title: 'pages.title' },
}));
vi.mock('@pagespace/db/schema/members', () => ({
  driveMembers: {
    id: 'dm.id', driveId: 'dm.driveId', userId: 'dm.userId',
    role: 'dm.role', acceptedAt: 'dm.acceptedAt', invitedBy: 'dm.invitedBy',
    invitedAt: 'dm.invitedAt',
  },
  pagePermissions: {
    id: 'pp.id', pageId: 'pp.pageId', userId: 'pp.userId',
    canView: 'pp.canView', canEdit: 'pp.canEdit', canShare: 'pp.canShare',
    canDelete: 'pp.canDelete', grantedBy: 'pp.grantedBy', grantedAt: 'pp.grantedAt',
  },
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'users.id', displayName: 'users.displayName' },
}));
vi.mock('@pagespace/db/schema/share-links', () => ({
  driveShareLinks: {
    id: 'dsl.id', driveId: 'dsl.driveId', token: 'dsl.token',
    role: 'dsl.role', createdBy: 'dsl.createdBy', createdAt: 'dsl.createdAt',
    expiresAt: 'dsl.expiresAt', isActive: 'dsl.isActive', useCount: 'dsl.useCount',
  },
  pageShareLinks: {
    id: 'psl.id', pageId: 'psl.pageId', token: 'psl.token',
    permissions: 'psl.permissions', createdBy: 'psl.createdBy', createdAt: 'psl.createdAt',
    expiresAt: 'psl.expiresAt', isActive: 'psl.isActive', useCount: 'psl.useCount',
  },
}));
vi.mock('../permissions', () => ({
  isDriveOwnerOrAdmin: vi.fn(),
  canUserSharePage: vi.fn(),
  isUserDriveMember: vi.fn(),
}));
vi.mock('../../auth/token-utils', () => ({
  generateToken: vi.fn(() => ({ token: 'ps_share_testtoken', tokenPrefix: 'ps_share_te' })),
  hashToken: vi.fn((t: string) => `hash:${t}`),
}));
// hashToken is mocked but must never be called by share-link-service — tests assert this.
vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'new-link-id'),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import {
  createDriveShareLink,
  revokeDriveShareLink,
  listDriveShareLinks,
  redeemDriveShareLink,
  createPageShareLink,
  revokePageShareLink,
  listPageShareLinks,
  redeemPageShareLink,
  resolveShareToken,
} from '../share-link-service';
import { EnforcedAuthContext } from '../enforced-context';
import { isDriveOwnerOrAdmin, canUserSharePage, isUserDriveMember } from '../permissions';
import { hashToken } from '../../auth/token-utils';
import type { SessionClaims } from '../../auth/session-service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACTOR_ID = 'clactorxxxxxxxxxxxxxxxxxx';
const DRIVE_ID = 'cldrivexxxxxxxxxxxxxxxxxx';
const PAGE_ID = 'clpagexxxxxxxxxxxxxxxxxx1';
const LINK_ID = 'cllinkxxxxxxxxxxxxxxxxxx1';

function makeCtx(userId = ACTOR_ID): EnforcedAuthContext {
  const claims: SessionClaims = {
    sessionId: 'sess', userId, userRole: 'user', tokenVersion: 1,
    adminRoleVersion: 0, type: 'user', scopes: ['*'],
    expiresAt: new Date(Date.now() + 3600_000),
    driveId: undefined,
  };
  return EnforcedAuthContext.fromSession(claims);
}

function makeSelectChain(result: unknown[]) {
  const terminal = {
    then: (resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(result).then(resolve, reject),
    limit: vi.fn().mockResolvedValue(result),
    orderBy: vi.fn().mockReturnThis(),
  };
  const chain = {
    from: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnValue(terminal),
    limit: vi.fn().mockResolvedValue(result),
    orderBy: vi.fn().mockReturnThis(),
  };
  mockDb.select.mockReturnValue(chain);
  return chain;
}

function makeInsertChain(result: unknown[] = []) {
  const chain = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(result),
    onConflictDoNothing: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
  };
  mockDb.insert.mockReturnValue(chain);
  return chain;
}

function makeUpdateChain(result: unknown[] = []) {
  const chain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(result),
  };
  mockDb.update.mockReturnValue(chain);
  return chain;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createDriveShareLink', () => {
  it('returns UNAUTHORIZED when caller is not owner/admin', async () => {
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(false);
    const ctx = makeCtx();

    const result = await createDriveShareLink(ctx, DRIVE_ID, {});

    expect(result).toEqual({ ok: false, error: 'UNAUTHORIZED' });
  });

  it('creates link and returns rawToken when caller is owner/admin', async () => {
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(true);
    makeInsertChain([{ id: LINK_ID }]);
    const ctx = makeCtx();

    const result = await createDriveShareLink(ctx, DRIVE_ID, { role: 'MEMBER' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe(LINK_ID);
      expect(result.data.rawToken).toBe('ps_share_testtoken');
    }
  });
});

describe('revokeDriveShareLink', () => {
  it('returns NOT_FOUND when link does not exist', async () => {
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(true);
    makeSelectChain([]);
    const ctx = makeCtx();

    const result = await revokeDriveShareLink(ctx, LINK_ID);

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' });
  });

  it('returns UNAUTHORIZED when caller is not owner/admin of the link drive', async () => {
    makeSelectChain([{ id: LINK_ID, driveId: DRIVE_ID }]);
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(false);
    const ctx = makeCtx();

    const result = await revokeDriveShareLink(ctx, LINK_ID);

    expect(result).toEqual({ ok: false, error: 'UNAUTHORIZED' });
  });

  it('sets isActive=false when caller owns the drive', async () => {
    makeSelectChain([{ id: LINK_ID, driveId: DRIVE_ID }]);
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(true);
    makeUpdateChain();
    const ctx = makeCtx();

    const result = await revokeDriveShareLink(ctx, LINK_ID);

    expect(result).toEqual({ ok: true, data: undefined });
    expect(mockDb.update).toHaveBeenCalled();
  });
});

describe('listDriveShareLinks', () => {
  it('returns UNAUTHORIZED for non-owner/admin', async () => {
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(false);

    const result = await listDriveShareLinks(makeCtx(), DRIVE_ID);

    expect(result).toEqual({ ok: false, error: 'UNAUTHORIZED' });
  });

  it('returns link list with expected view fields', async () => {
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(true);
    makeSelectChain([
      { id: LINK_ID, role: 'MEMBER', useCount: 3, expiresAt: null, createdAt: new Date(), token: 'ps_share_testtoken' },
    ]);

    const result = await listDriveShareLinks(makeCtx(), DRIVE_ID);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data[0].id).toBe(LINK_ID);
      expect(result.data[0].useCount).toBe(3);
      expect(result.data[0].role).toBe('MEMBER');
      expect(result.data[0].token).toBe('ps_share_testtoken');
    }
  });
});

describe('redeemDriveShareLink', () => {
  it('does not hash the token — looks up by plaintext token directly', async () => {
    makeSelectChain([]);

    await redeemDriveShareLink(makeCtx(), 'some-token');

    expect(vi.mocked(hashToken)).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND for unknown token', async () => {
    makeSelectChain([]);

    const result = await redeemDriveShareLink(makeCtx(), 'unknown-token');

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' });
  });

  it('returns NOT_FOUND for expired token', async () => {
    const past = new Date(Date.now() - 1000);
    makeSelectChain([{ id: LINK_ID, driveId: DRIVE_ID, role: 'MEMBER', isActive: true, expiresAt: past }]);

    const result = await redeemDriveShareLink(makeCtx(), 'some-token');

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' });
  });

  it('returns NOT_FOUND for revoked token (isActive=false)', async () => {
    makeSelectChain([{ id: LINK_ID, driveId: DRIVE_ID, role: 'MEMBER', isActive: false, expiresAt: null }]);

    const result = await redeemDriveShareLink(makeCtx(), 'some-token');

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' });
  });

  it('returns ALREADY_MEMBER with driveId without mutation when user is already a member', async () => {
    makeSelectChain([{ id: LINK_ID, driveId: DRIVE_ID, role: 'MEMBER', isActive: true, expiresAt: null }]);
    vi.mocked(isUserDriveMember).mockResolvedValue(true);

    const result = await redeemDriveShareLink(makeCtx(), 'some-token');

    expect(result).toEqual({ ok: false, error: 'ALREADY_MEMBER', driveId: DRIVE_ID });
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('creates drive membership and increments useCount for valid token', async () => {
    mockDb.select.mockImplementation(() => ({
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{
        id: LINK_ID, driveId: DRIVE_ID, role: 'MEMBER',
        isActive: true, expiresAt: null, driveName: 'Test Drive',
        createdBy: 'creator-user-id',
      }]),
    }));
    vi.mocked(isUserDriveMember).mockResolvedValue(false);
    makeInsertChain([{ id: 'new-member-id' }]);
    makeUpdateChain();

    const result = await redeemDriveShareLink(makeCtx(), 'valid-token');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.driveId).toBe(DRIVE_ID);
      expect(result.data.linkId).toBe(LINK_ID);
      expect(result.data.memberId).toBe('new-member-id');
      expect(result.data.driveName).toBe('Test Drive');
      expect(result.data.role).toBe('MEMBER');
      expect(result.data.createdBy).toBe('creator-user-id');
    }
    expect(mockDb.insert).toHaveBeenCalled();
    expect(mockDb.update).toHaveBeenCalled();
  });

  it('ADMIN role preservation: onConflictDoUpdate is called with role-preserving SQL when upserting membership', async () => {
    mockDb.select.mockImplementation(() => ({
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{
        id: LINK_ID, driveId: DRIVE_ID, role: 'MEMBER',
        isActive: true, expiresAt: null, driveName: 'Admin Drive',
        createdBy: 'creator-id',
      }]),
    }));
    vi.mocked(isUserDriveMember).mockResolvedValue(false);
    const insertChain = makeInsertChain([{ id: 'existing-admin-member-id' }]);
    makeUpdateChain();

    await redeemDriveShareLink(makeCtx(), 'member-share-token');

    expect(insertChain.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.arrayContaining([expect.anything(), expect.anything()]),
        set: expect.objectContaining({
          role: expect.anything(),
        }),
      })
    );
  });
});

describe('createPageShareLink', () => {
  it('returns INVALID_PERMISSIONS when EDIT is specified without VIEW', async () => {
    const result = await createPageShareLink(makeCtx(), PAGE_ID, { permissions: ['EDIT'] });

    expect(result).toEqual({ ok: false, error: 'INVALID_PERMISSIONS' });
    expect(canUserSharePage).not.toHaveBeenCalled();
  });

  it('returns INVALID_PERMISSIONS when empty permissions array is specified', async () => {
    const result = await createPageShareLink(makeCtx(), PAGE_ID, { permissions: [] });

    expect(result).toEqual({ ok: false, error: 'INVALID_PERMISSIONS' });
    expect(canUserSharePage).not.toHaveBeenCalled();
  });

  it('returns UNAUTHORIZED when caller lacks canShare', async () => {
    vi.mocked(canUserSharePage).mockResolvedValue(false);

    const result = await createPageShareLink(makeCtx(), PAGE_ID, { permissions: ['VIEW'] });

    expect(result).toEqual({ ok: false, error: 'UNAUTHORIZED' });
  });

  it('defaults permissions to [VIEW] when omitted', async () => {
    vi.mocked(canUserSharePage).mockResolvedValue(true);
    makeInsertChain([{ id: LINK_ID }]);

    const result = await createPageShareLink(makeCtx(), PAGE_ID, {});

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.rawToken).toBe('ps_share_testtoken');
  });

  it('creates link with VIEW+EDIT permissions', async () => {
    vi.mocked(canUserSharePage).mockResolvedValue(true);
    makeInsertChain([{ id: LINK_ID }]);

    const result = await createPageShareLink(makeCtx(), PAGE_ID, { permissions: ['VIEW', 'EDIT'] });

    expect(result.ok).toBe(true);
  });
});

describe('revokePageShareLink', () => {
  it('returns NOT_FOUND when link does not exist', async () => {
    makeSelectChain([]);

    const result = await revokePageShareLink(makeCtx(), LINK_ID);

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' });
  });

  it('returns UNAUTHORIZED when caller lacks canShare on the page', async () => {
    makeSelectChain([{ id: LINK_ID, pageId: PAGE_ID }]);
    vi.mocked(canUserSharePage).mockResolvedValue(false);

    const result = await revokePageShareLink(makeCtx(), LINK_ID);

    expect(result).toEqual({ ok: false, error: 'UNAUTHORIZED' });
  });

  it('sets isActive=false when caller has canShare', async () => {
    makeSelectChain([{ id: LINK_ID, pageId: PAGE_ID }]);
    vi.mocked(canUserSharePage).mockResolvedValue(true);
    makeUpdateChain();

    const result = await revokePageShareLink(makeCtx(), LINK_ID);

    expect(result).toEqual({ ok: true, data: undefined });
    expect(mockDb.update).toHaveBeenCalled();
  });
});

describe('listPageShareLinks', () => {
  it('returns UNAUTHORIZED when caller lacks canShare', async () => {
    vi.mocked(canUserSharePage).mockResolvedValue(false);

    const result = await listPageShareLinks(makeCtx(), PAGE_ID);

    expect(result).toEqual({ ok: false, error: 'UNAUTHORIZED' });
  });

  it('returns link list with expected view fields', async () => {
    vi.mocked(canUserSharePage).mockResolvedValue(true);
    makeSelectChain([
      { id: LINK_ID, permissions: ['VIEW'], useCount: 1, expiresAt: null, createdAt: new Date(), token: 'ps_share_testtoken' },
    ]);

    const result = await listPageShareLinks(makeCtx(), PAGE_ID);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data[0].id).toBe(LINK_ID);
      expect(result.data[0].permissions).toEqual(['VIEW']);
      expect(result.data[0].useCount).toBe(1);
      expect(result.data[0].token).toBe('ps_share_testtoken');
    }
  });
});

describe('redeemPageShareLink', () => {
  it('does not hash the token — looks up by plaintext token directly', async () => {
    makeSelectChain([]);

    await redeemPageShareLink(makeCtx(), 'bad-token');

    expect(vi.mocked(hashToken)).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND for invalid/revoked/expired token', async () => {
    makeSelectChain([]);

    const result = await redeemPageShareLink(makeCtx(), 'bad-token');

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' });
  });

  it('auto-creates drive membership when user is not yet a member', async () => {
    let callCount = 0;
    mockDb.select.mockImplementation(() => ({
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve([{
            id: LINK_ID, pageId: PAGE_ID, driveId: DRIVE_ID,
            permissions: ['VIEW'], isActive: true, expiresAt: null,
          }]);
        }
        return Promise.resolve([]);
      }),
    }));
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([{ id: 'new-pp-id' }]),
      onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    });
    makeUpdateChain();

    const result = await redeemPageShareLink(makeCtx(), 'valid-token');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.pageId).toBe(PAGE_ID);
      expect(result.data.linkId).toBe(LINK_ID);
    }
    expect(mockDb.insert).toHaveBeenCalledTimes(2);
  });

  it('skips useCount increment when user already has canView access', async () => {
    let callCount = 0;
    mockDb.select.mockImplementation(() => ({
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve([{
            id: LINK_ID, pageId: PAGE_ID, driveId: DRIVE_ID,
            permissions: ['VIEW'], isActive: true, expiresAt: null,
          }]);
        }
        // existingPerms query returns a row with canView=true
        return Promise.resolve([{ canView: true }]);
      }),
    }));
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([{ id: 'new-pp-id' }]),
      onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    });
    makeUpdateChain();

    const result = await redeemPageShareLink(makeCtx(), 'valid-token');

    expect(result.ok).toBe(true);
    // useCount update must NOT be called because user already had access
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});

describe('resolveShareToken', () => {
  it('does not hash the token — looks up by plaintext token directly', async () => {
    makeSelectChain([]);

    await resolveShareToken('any-token');

    expect(vi.mocked(hashToken)).not.toHaveBeenCalled();
  });

  it('returns null for not-found token (no throw)', async () => {
    makeSelectChain([]);

    const result = await resolveShareToken('nonexistent');

    expect(result).toBeNull();
  });

  it('returns null for expired token without throwing', async () => {
    makeSelectChain([{
      id: LINK_ID, driveId: DRIVE_ID, isActive: true,
      expiresAt: new Date(Date.now() - 1000), driveName: 'My Drive', creatorName: 'Bob',
    }]);

    const result = await resolveShareToken('expired-token');

    expect(result).toBeNull();
  });

  it('returns drive info for valid drive share token', async () => {
    let callCount = 0;
    mockDb.select.mockImplementation(() => ({
      from: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve([{
            id: LINK_ID, driveId: DRIVE_ID, role: 'MEMBER',
            isActive: true, expiresAt: null, useCount: 5,
            driveName: 'My Drive', creatorName: 'Alice',
          }]);
        }
        return Promise.resolve([]);
      }),
    }));

    const result = await resolveShareToken('valid-drive-token');

    expect(result).not.toBeNull();
    expect(result?.type).toBe('drive');
    expect(result?.driveName).toBe('My Drive');
    expect(result?.creatorName).toBe('Alice');
  });

  it('returns page info for valid page share token when drive lookup returns nothing', async () => {
    let callCount = 0;
    mockDb.select.mockImplementation(() => ({
      from: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve([]);
        return Promise.resolve([{
          id: LINK_ID, pageId: PAGE_ID, driveId: DRIVE_ID,
          permissions: ['VIEW'], isActive: true, expiresAt: null,
          useCount: 2, pageTitle: 'My Page', driveName: 'My Drive', creatorName: 'Bob',
        }]);
      }),
    }));

    const result = await resolveShareToken('valid-page-token');

    expect(result).not.toBeNull();
    expect(result?.type).toBe('page');
    expect(result?.pageTitle).toBe('My Page');
  });
});
