import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(),
  },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: {
    id: 'id',
    driveId: 'driveId',
    isPrivate: 'isPrivate',
    isTrashed: 'isTrashed',
    title: 'title',
    type: 'type',
    parentId: 'parentId',
    position: 'position',
  },
  drives: { id: 'id', ownerId: 'ownerId' },
}));
vi.mock('@pagespace/db/schema/members', () => ({
  driveMembers: {
    driveId: 'driveId',
    userId: 'userId',
    role: 'role',
    id: 'id',
    acceptedAt: 'acceptedAt',
    customRoleId: 'customRoleId',
  },
  pagePermissions: {
    pageId: 'pageId',
    userId: 'userId',
    canView: 'canView',
    canEdit: 'canEdit',
    canShare: 'canShare',
    canDelete: 'canDelete',
    expiresAt: 'expiresAt',
    id: 'id',
  },
  driveRoles: { id: 'id', driveId: 'driveId', permissions: 'permissions' },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((_a: unknown, _b: unknown) => 'eq'),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  isNull: vi.fn((a: unknown) => ({ isNull: a })),
  isNotNull: vi.fn((a: unknown) => ({ isNotNull: a })),
  gt: vi.fn((a: unknown, b: unknown) => ({ gt: { a, b } })),
  inArray: vi.fn((a: unknown, b: unknown) => ({ inArray: { a, b } })),
}));
vi.mock('../../logging/logger-config', () => ({
  loggers: {
    api: {
      debug: vi.fn(),
      error: vi.fn(),
    },
  },
}));
vi.mock('../../validators/id-validators', () => ({
  parseUserId: vi.fn(),
  parsePageId: vi.fn(),
}));

import { getUserAccessiblePagesInDrive, getUserAccessiblePagesInDriveWithDetails } from '../permissions';
import { db } from '@pagespace/db/db';

const VALID_USER = 'clxxxxxxxxxxxxxxxxxxxxxxx';
const VALID_DRIVE = 'clzzzzzzzzzzzzzzzzzzzzzzz';
const CUSTOM_ROLE_ID = 'clrolexxxxxxxxxxxxxxxxxx';

function mockChainWhere(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
    }),
  } as unknown as ReturnType<typeof db.select>;
}

function mockChainWhereNoLimit(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  } as unknown as ReturnType<typeof db.select>;
}

function mockChainWhereInArray(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  } as unknown as ReturnType<typeof db.select>;
}

function mockChainLeftJoinWhere(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      leftJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }),
    }),
  } as unknown as ReturnType<typeof db.select>;
}

function mockChainInnerJoinWhere(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }),
    }),
  } as unknown as ReturnType<typeof db.select>;
}

describe('getUserAccessiblePagesInDrive — custom role path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given MEMBER with custom role granting canView on a PRIVATE page, should include that private page', async () => {
    const rolePerms = { 'private-page': { canView: true, canEdit: false, canShare: false } };
    vi.mocked(db.select)
      // 1. drive lookup (not owner)
      .mockReturnValueOnce(mockChainWhere([{ ownerId: 'other-user' }]))
      // 2. admin check (not admin)
      .mockReturnValueOnce(mockChainWhere([]))
      // 3. member check → has custom role
      .mockReturnValueOnce(mockChainWhere([{ id: 'row', customRoleId: CUSTOM_ROLE_ID }]))
      // 4. non-private pages
      .mockReturnValueOnce(mockChainWhereNoLimit([]))
      // 5. fetchCustomRolePermissions internal call
      .mockReturnValueOnce(mockChainWhere([{ permissions: rolePerms }]))
      // 6. explicit permissions
      .mockReturnValueOnce(mockChainLeftJoinWhere([]));

    const result = await getUserAccessiblePagesInDrive(VALID_USER, VALID_DRIVE);
    expect(result).toContain('private-page');
  });

  it('given MEMBER with custom role with NO canView entry for private page, should NOT include it', async () => {
    const rolePerms = { 'private-page': { canView: false, canEdit: false, canShare: false } };
    vi.mocked(db.select)
      // 1. drive lookup (not owner)
      .mockReturnValueOnce(mockChainWhere([{ ownerId: 'other-user' }]))
      // 2. admin check (not admin)
      .mockReturnValueOnce(mockChainWhere([]))
      // 3. member check → has custom role
      .mockReturnValueOnce(mockChainWhere([{ id: 'row', customRoleId: CUSTOM_ROLE_ID }]))
      // 4. non-private pages (none)
      .mockReturnValueOnce(mockChainWhereNoLimit([]))
      // 5. fetchCustomRolePermissions internal call
      .mockReturnValueOnce(mockChainWhere([{ permissions: rolePerms }]))
      // 6. explicit permissions (none)
      .mockReturnValueOnce(mockChainLeftJoinWhere([]));

    const result = await getUserAccessiblePagesInDrive(VALID_USER, VALID_DRIVE);
    expect(result).not.toContain('private-page');
    expect(result).toHaveLength(0);
  });

  it('given MEMBER with custom role entry {canView:false} on a NON-PRIVATE page, should remove it from accessible set', async () => {
    const rolePerms = { 'non-private-page': { canView: false, canEdit: false, canShare: false } };
    vi.mocked(db.select)
      // 1. drive lookup (not owner)
      .mockReturnValueOnce(mockChainWhere([{ ownerId: 'other-user' }]))
      // 2. admin check (not admin)
      .mockReturnValueOnce(mockChainWhere([]))
      // 3. member check → has custom role
      .mockReturnValueOnce(mockChainWhere([{ id: 'row', customRoleId: CUSTOM_ROLE_ID }]))
      // 4. non-private pages (includes page that role will deny)
      .mockReturnValueOnce(mockChainWhereNoLimit([{ id: 'non-private-page' }]))
      // 5. fetchCustomRolePermissions internal call
      .mockReturnValueOnce(mockChainWhere([{ permissions: rolePerms }]))
      // 6. explicit permissions (none)
      .mockReturnValueOnce(mockChainLeftJoinWhere([]));

    const result = await getUserAccessiblePagesInDrive(VALID_USER, VALID_DRIVE);
    expect(result).not.toContain('non-private-page');
    expect(result).toHaveLength(0);
  });

  it('given MEMBER with NO custom role, should behave unchanged (non-private + explicit only)', async () => {
    vi.mocked(db.select)
      // 1. drive lookup (not owner)
      .mockReturnValueOnce(mockChainWhere([{ ownerId: 'other-user' }]))
      // 2. admin check (not admin)
      .mockReturnValueOnce(mockChainWhere([]))
      // 3. member check → no custom role
      .mockReturnValueOnce(mockChainWhere([{ id: 'row', customRoleId: null }]))
      // 4. non-private pages
      .mockReturnValueOnce(mockChainWhereNoLimit([{ id: 'non-private-page' }]))
      // 5. explicit permissions
      .mockReturnValueOnce(mockChainLeftJoinWhere([]));

    const result = await getUserAccessiblePagesInDrive(VALID_USER, VALID_DRIVE);
    expect(result).toContain('non-private-page');
    expect(db.select).toHaveBeenCalledTimes(5);
  });
});

describe('getUserAccessiblePagesInDriveWithDetails — custom role path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given MEMBER with custom role granting canEdit on a NON-PRIVATE page, should return canEdit true', async () => {
    const rolePerms = { 'page-1': { canView: true, canEdit: true, canShare: false } };
    const nonPrivatePages = [
      { id: 'page-1', title: 'Page 1', type: 'DOCUMENT', parentId: null, position: 1, isTrashed: false },
    ];
    vi.mocked(db.select)
      // 1. drive lookup (not owner)
      .mockReturnValueOnce(mockChainWhere([{ ownerId: 'other-user' }]))
      // 2. admin check (not admin)
      .mockReturnValueOnce(mockChainWhere([]))
      // 3. member check → has custom role
      .mockReturnValueOnce(mockChainWhere([{ id: 'row', customRoleId: CUSTOM_ROLE_ID }]))
      // 4. non-private pages (page-1)
      .mockReturnValueOnce(mockChainWhereNoLimit(nonPrivatePages))
      // 5. fetchCustomRolePermissions internal call
      .mockReturnValueOnce(mockChainWhere([{ permissions: rolePerms }]))
      // 6. role pages query (inArray)
      .mockReturnValueOnce(mockChainWhereInArray(nonPrivatePages))
      // 7. explicit pages (none)
      .mockReturnValueOnce(mockChainInnerJoinWhere([]));

    const result = await getUserAccessiblePagesInDriveWithDetails(VALID_USER, VALID_DRIVE);
    const page = result.find(p => p.id === 'page-1');
    expect(page).toBeDefined();
    expect(page?.permissions).toEqual({ canView: true, canEdit: true, canShare: false, canDelete: false });
  });

  it('given MEMBER with custom role entry {canView:false} on a NON-PRIVATE page, should remove it from the page map', async () => {
    const rolePerms = { 'non-private-page': { canView: false, canEdit: false, canShare: false } };
    const nonPrivatePage = [
      { id: 'non-private-page', title: 'Public', type: 'DOCUMENT', parentId: null, position: 1, isTrashed: false },
    ];
    vi.mocked(db.select)
      // 1. drive lookup (not owner)
      .mockReturnValueOnce(mockChainWhere([{ ownerId: 'other-user' }]))
      // 2. admin check (not admin)
      .mockReturnValueOnce(mockChainWhere([]))
      // 3. member check → has custom role
      .mockReturnValueOnce(mockChainWhere([{ id: 'row', customRoleId: CUSTOM_ROLE_ID }]))
      // 4. non-private pages (includes page that role will deny)
      .mockReturnValueOnce(mockChainWhereNoLimit(nonPrivatePage))
      // 5. fetchCustomRolePermissions internal call
      .mockReturnValueOnce(mockChainWhere([{ permissions: rolePerms }]))
      // no role pages query — no canView=true entries
      // 6. explicit pages (none)
      .mockReturnValueOnce(mockChainInnerJoinWhere([]));

    const result = await getUserAccessiblePagesInDriveWithDetails(VALID_USER, VALID_DRIVE);
    expect(result.find(p => p.id === 'non-private-page')).toBeUndefined();
    expect(result).toHaveLength(0);
  });

  it('given MEMBER with custom role granting canView on a PRIVATE page, should include it with role perms', async () => {
    const rolePerms = { 'private-1': { canView: true, canEdit: false, canShare: false } };
    const privatePage = [
      { id: 'private-1', title: 'Private', type: 'DOCUMENT', parentId: null, position: 1, isTrashed: false },
    ];
    vi.mocked(db.select)
      // 1. drive lookup (not owner)
      .mockReturnValueOnce(mockChainWhere([{ ownerId: 'other-user' }]))
      // 2. admin check (not admin)
      .mockReturnValueOnce(mockChainWhere([]))
      // 3. member check → has custom role
      .mockReturnValueOnce(mockChainWhere([{ id: 'row', customRoleId: CUSTOM_ROLE_ID }]))
      // 4. non-private pages (none — private-1 is private)
      .mockReturnValueOnce(mockChainWhereNoLimit([]))
      // 5. fetchCustomRolePermissions internal call
      .mockReturnValueOnce(mockChainWhere([{ permissions: rolePerms }]))
      // 6. role pages query (inArray)
      .mockReturnValueOnce(mockChainWhereInArray(privatePage))
      // 7. explicit pages (none)
      .mockReturnValueOnce(mockChainInnerJoinWhere([]));

    const result = await getUserAccessiblePagesInDriveWithDetails(VALID_USER, VALID_DRIVE);
    const page = result.find(p => p.id === 'private-1');
    expect(page).toBeDefined();
    expect(page?.permissions).toEqual({ canView: true, canEdit: false, canShare: false, canDelete: false });
  });
});
