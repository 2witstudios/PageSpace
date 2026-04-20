import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createId } from '@paralleldrive/cuid2';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn(),
    transaction: vi.fn(),
    delete: vi.fn(),
  },
  pages: { id: 'id', driveId: 'driveId' },
  drives: { id: 'id', ownerId: 'ownerId' },
  driveMembers: { driveId: 'driveId', userId: 'userId', role: 'role', id: 'id' },
  pagePermissions: {
    pageId: 'pageId', userId: 'userId', canView: 'canView', canEdit: 'canEdit',
    canShare: 'canShare', canDelete: 'canDelete', id: 'id', grantedBy: 'grantedBy',
  },
  users: { id: 'id' },
  eq: vi.fn((_a, _b) => 'eq'),
  and: vi.fn((...args) => ({ and: args })),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'new-perm-id'),
  isCuid: vi.fn((id: string) => id.startsWith('cl') && id.length === 25),
}));

vi.mock('../enforced-context', () => ({
  EnforcedAuthContext: class {
    userId: string;
    userRole: string;
    constructor(userId: string, userRole: string) {
      this.userId = userId;
      this.userRole = userRole;
    }
    static fromSession(claims: { userId: string; userRole: string; scopes: string[] }) {
      const ctx = new (this as unknown as new(u: string, r: string) => { userId: string; userRole: string })(claims.userId, claims.userRole);
      return ctx;
    }
  },
}));

vi.mock('../../monitoring/activity-logger', () => ({
  logPermissionActivity: vi.fn().mockResolvedValue(undefined),
  getActorInfo: vi.fn().mockResolvedValue({ actorEmail: 'actor@test.com', actorDisplayName: 'Actor' }),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { grantPagePermission, revokePagePermission } from '../permission-mutations';
import { db } from '@pagespace/db';
import { EnforcedAuthContext } from '../enforced-context';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Generate valid CUID2-like IDs (25 chars starting with 'cl')
const ACTOR_ID = 'clactorxxxxxxxxxxxxxxxxxx';
const TARGET_ID = 'cltargetxxxxxxxxxxxxxxxxx';
const PAGE_ID = 'clpagexxxxxxxxxxxxxxxxxx1';
const DRIVE_ID = 'cldrivexxxxxxxxxxxxxxxxxx';

function makeCtx(userId = ACTOR_ID): EnforcedAuthContext {
  return EnforcedAuthContext.fromSession({
    userId,
    userRole: 'user',
    scopes: ['*'],
    sessionId: 'sess',
    tokenVersion: 1,
    adminRoleVersion: 0,
    type: 'service',
    expiresAt: new Date(Date.now() + 3600000),
  } as Parameters<typeof EnforcedAuthContext.fromSession>[0]);
}

function validGrantInput() {
  return {
    pageId: PAGE_ID,
    targetUserId: TARGET_ID,
    permissions: { canView: true, canEdit: false, canShare: false, canDelete: false },
  };
}

function validRevokeInput() {
  return { pageId: PAGE_ID, targetUserId: TARGET_ID };
}

// Mock the page lookup for getPageIfCanShare (drive owner path)
function mockPageAsOwner() {
  vi.mocked(db.select)
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: PAGE_ID, driveId: DRIVE_ID, driveOwnerId: ACTOR_ID }]),
          }),
        }),
      }),
    } as unknown as ReturnType<typeof db.select>);
}

// Mock page not accessible
function mockPageNotFound() {
  vi.mocked(db.select)
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
        }),
      }),
    } as unknown as ReturnType<typeof db.select>);
}

// Mock target user exists
function mockUserExists(exists = true) {
  vi.mocked(db.select)
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(exists ? [{ id: TARGET_ID }] : []),
        }),
      }),
    } as unknown as ReturnType<typeof db.select>);
}

// Mock transaction for grant
function mockTransactionInsert(newId: string) {
  const tx = {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: newId }]),
        }),
      }),
    }),
    update: vi.fn(),
  };
  vi.mocked(db.transaction).mockImplementation(async (fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
  return tx;
}

function mockTransactionConflict(existingId: string) {
  const tx = {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]), // Empty = conflict
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: existingId }]),
        }),
      }),
    }),
  };
  vi.mocked(db.transaction).mockImplementation(async (fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
  return tx;
}

// ---------------------------------------------------------------------------
// grantPagePermission
// ---------------------------------------------------------------------------
describe('grantPagePermission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns VALIDATION_FAILED for invalid input (missing fields)', async () => {
    const ctx = makeCtx();
    const result = await grantPagePermission(ctx, { pageId: 'not-a-cuid' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('returns VALIDATION_FAILED for non-CUID2 pageId', async () => {
    const ctx = makeCtx();
    const result = await grantPagePermission(ctx, {
      pageId: 'invalid-page-id',
      targetUserId: TARGET_ID,
      permissions: { canView: true, canEdit: false, canShare: false, canDelete: false },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('returns INVALID_PERMISSION_COMBINATION for edit without view', async () => {
    const ctx = makeCtx();
    const result = await grantPagePermission(ctx, {
      pageId: PAGE_ID,
      targetUserId: TARGET_ID,
      permissions: { canView: false, canEdit: true, canShare: false, canDelete: false },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_PERMISSION_COMBINATION');
    }
  });

  it('returns INVALID_PERMISSION_COMBINATION for share without view', async () => {
    const ctx = makeCtx();
    const result = await grantPagePermission(ctx, {
      pageId: PAGE_ID,
      targetUserId: TARGET_ID,
      permissions: { canView: false, canEdit: false, canShare: true, canDelete: false },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_PERMISSION_COMBINATION');
    }
  });

  it('returns INVALID_PERMISSION_COMBINATION for delete without view', async () => {
    const ctx = makeCtx();
    const result = await grantPagePermission(ctx, {
      pageId: PAGE_ID,
      targetUserId: TARGET_ID,
      permissions: { canView: false, canEdit: false, canShare: false, canDelete: true },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_PERMISSION_COMBINATION');
    }
  });

  it('returns SELF_PERMISSION_DENIED when actor === target', async () => {
    const ctx = makeCtx(ACTOR_ID);
    const result = await grantPagePermission(ctx, {
      pageId: PAGE_ID,
      targetUserId: ACTOR_ID,
      permissions: { canView: true, canEdit: false, canShare: false, canDelete: false },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SELF_PERMISSION_DENIED');
    }
  });

  it('returns PAGE_NOT_ACCESSIBLE when page not found', async () => {
    const ctx = makeCtx();
    mockPageNotFound();

    const result = await grantPagePermission(ctx, validGrantInput());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PAGE_NOT_ACCESSIBLE');
    }
  });

  it('returns USER_NOT_FOUND when target user does not exist', async () => {
    const ctx = makeCtx();
    mockPageAsOwner();
    mockUserExists(false);

    const result = await grantPagePermission(ctx, validGrantInput());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('USER_NOT_FOUND');
    }
  });

  it('returns ok=true with isUpdate=false on new insert', async () => {
    const ctx = makeCtx();
    mockPageAsOwner();
    mockUserExists(true);
    mockTransactionInsert('new-perm-id');

    const result = await grantPagePermission(ctx, validGrantInput());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.isUpdate).toBe(false);
      expect(result.data.permissionId).toBe('new-perm-id');
    }
  });

  it('returns ok=true with isUpdate=true on conflict (update path)', async () => {
    const ctx = makeCtx();
    mockPageAsOwner();
    mockUserExists(true);
    mockTransactionConflict('existing-perm-id');

    const result = await grantPagePermission(ctx, validGrantInput());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.isUpdate).toBe(true);
      expect(result.data.permissionId).toBe('existing-perm-id');
    }
  });

  it('allows view-only permission (valid combination)', async () => {
    const ctx = makeCtx();
    mockPageAsOwner();
    mockUserExists(true);
    mockTransactionInsert('perm-view-only');

    const result = await grantPagePermission(ctx, {
      pageId: PAGE_ID,
      targetUserId: TARGET_ID,
      permissions: { canView: true, canEdit: false, canShare: false, canDelete: false },
    });

    expect(result.ok).toBe(true);
  });

  it('allows all permissions (valid combination)', async () => {
    const ctx = makeCtx();
    mockPageAsOwner();
    mockUserExists(true);
    mockTransactionInsert('perm-all');

    const result = await grantPagePermission(ctx, {
      pageId: PAGE_ID,
      targetUserId: TARGET_ID,
      permissions: { canView: true, canEdit: true, canShare: true, canDelete: true },
    });

    expect(result.ok).toBe(true);
  });

  it('allows grant when actor is drive admin (not owner)', async () => {
    const ADMIN_USER_ID = 'cladminxxxxxxxxxxxxxxxx1';
    const ctx = makeCtx(ADMIN_USER_ID);

    // Page exists but user is NOT the owner
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: PAGE_ID, driveId: DRIVE_ID, driveOwnerId: 'clotherxxxxxxxxxxxxxxxxxx' }]),
            }),
          }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      // Admin membership check returns match
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: 'admin-membership-id' }]),
          }),
        }),
      } as unknown as ReturnType<typeof db.select>);

    mockUserExists(true);
    mockTransactionInsert('admin-granted-perm');

    const result = await grantPagePermission(ctx, {
      pageId: PAGE_ID,
      targetUserId: TARGET_ID,
      permissions: { canView: true, canEdit: false, canShare: false, canDelete: false },
    });

    expect(result.ok).toBe(true);
  });

  it('allows grant when actor has explicit share permission', async () => {
    const SHARER_USER_ID = 'clsharerxxxxxxxxxxxxxx1';
    const ctx = makeCtx(SHARER_USER_ID);

    // Page exists but user is NOT the owner
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: PAGE_ID, driveId: DRIVE_ID, driveOwnerId: 'clotherxxxxxxxxxxxxxxxxxx' }]),
            }),
          }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      // Admin membership check - NOT admin
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      // Share permission check - has canShare
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ canShare: true }]),
          }),
        }),
      } as unknown as ReturnType<typeof db.select>);

    mockUserExists(true);
    mockTransactionInsert('share-perm-granted');

    const result = await grantPagePermission(ctx, {
      pageId: PAGE_ID,
      targetUserId: TARGET_ID,
      permissions: { canView: true, canEdit: false, canShare: false, canDelete: false },
    });

    expect(result.ok).toBe(true);
  });

  it('returns PAGE_NOT_ACCESSIBLE when actor has no share permission', async () => {
    const NO_PERM_USER_ID = 'clnopermxxxxxxxxxxxxxxx1';
    const ctx = makeCtx(NO_PERM_USER_ID);

    // Page exists but user is NOT the owner
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: PAGE_ID, driveId: DRIVE_ID, driveOwnerId: 'clotherxxxxxxxxxxxxxxxxxx' }]),
            }),
          }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      // Admin membership check - NOT admin
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      // Share permission check - no canShare
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ canShare: false }]),
          }),
        }),
      } as unknown as ReturnType<typeof db.select>);

    const result = await grantPagePermission(ctx, {
      pageId: PAGE_ID,
      targetUserId: TARGET_ID,
      permissions: { canView: true, canEdit: false, canShare: false, canDelete: false },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PAGE_NOT_ACCESSIBLE');
    }
  });
});

// ---------------------------------------------------------------------------
// revokePagePermission
// ---------------------------------------------------------------------------
describe('revokePagePermission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns VALIDATION_FAILED for invalid input', async () => {
    const ctx = makeCtx();
    const result = await revokePagePermission(ctx, { pageId: 'bad-id' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('returns SELF_PERMISSION_DENIED when actor === target', async () => {
    const ctx = makeCtx(ACTOR_ID);
    const result = await revokePagePermission(ctx, {
      pageId: PAGE_ID,
      targetUserId: ACTOR_ID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SELF_PERMISSION_DENIED');
    }
  });

  it('returns PAGE_NOT_ACCESSIBLE when page not found', async () => {
    const ctx = makeCtx();
    mockPageNotFound();

    const result = await revokePagePermission(ctx, validRevokeInput());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PAGE_NOT_ACCESSIBLE');
    }
  });

  it('returns ok=true with revoked=false when permission not found (idempotent)', async () => {
    const ctx = makeCtx();
    mockPageAsOwner();

    // No existing permission found
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as unknown as ReturnType<typeof db.select>);

    const result = await revokePagePermission(ctx, validRevokeInput());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.revoked).toBe(false);
      expect((result.data as { revoked: false; reason: string }).reason).toBe('not_found');
    }
  });

  it('returns ok=true with revoked=true when permission deleted', async () => {
    const ctx = makeCtx();
    mockPageAsOwner();

    // Existing permission found
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'existing-perm-id',
            canView: true,
            canEdit: false,
            canShare: false,
            canDelete: false,
            grantedBy: 'some-user',
          }]),
        }),
      }),
    } as unknown as ReturnType<typeof db.select>);

    // Mock delete
    const whereFn = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.delete).mockReturnValue({ where: whereFn } as unknown as ReturnType<typeof db.delete>);

    const result = await revokePagePermission(ctx, validRevokeInput());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.revoked).toBe(true);
      expect((result.data as { revoked: true; permissionId: string }).permissionId).toBe('existing-perm-id');
    }
  });
});
