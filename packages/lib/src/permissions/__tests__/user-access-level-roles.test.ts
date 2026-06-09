import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(),
  },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', driveId: 'driveId', isPrivate: 'isPrivate', type: 'type' },
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

import { getUserAccessLevel } from '../permissions';
import { db } from '@pagespace/db/db';
import { parseUserId, parsePageId } from '../../validators/id-validators';

const VALID_USER = 'clxxxxxxxxxxxxxxxxxxxxxxx';
const VALID_PAGE = 'clyyyyyyyyyyyyyyyyyyyyyyy';
const VALID_DRIVE = 'clzzzzzzzzzzzzzzzzzzzzzzz';
const CUSTOM_ROLE_ID = 'clrolexxxxxxxxxxxxxxxxxx';

function mockValidators() {
  vi.mocked(parseUserId).mockReturnValue({ success: true, data: VALID_USER });
  vi.mocked(parsePageId).mockReturnValue({ success: true, data: VALID_PAGE });
}

function makePageRow(isPrivate = false, type = 'DOCUMENT') {
  return [{ id: VALID_PAGE, driveId: VALID_DRIVE, driveOwnerId: 'other-owner', isPrivate, type }];
}

function mockSelectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
    }),
  } as unknown as ReturnType<typeof db.select>;
}

function mockSelectChainWithLeftJoin(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      leftJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
      }),
    }),
  } as unknown as ReturnType<typeof db.select>;
}

describe('getUserAccessLevel — custom role (MEMBER path)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidators();
  });

  it('given MEMBER with custom role entry {canView:true} on a PRIVATE page, returns read-only', async () => {
    const rolePerms = { [VALID_PAGE]: { canView: true, canEdit: false, canShare: false } };
    vi.mocked(db.select)
      .mockReturnValueOnce(mockSelectChainWithLeftJoin(makePageRow(true)))
      .mockReturnValueOnce(mockSelectChain([{ role: 'MEMBER', customRoleId: CUSTOM_ROLE_ID }]))
      .mockReturnValueOnce(mockSelectChain([]))
      .mockReturnValueOnce(mockSelectChain([{ permissions: rolePerms, driveWidePermissions: null }]));

    const result = await getUserAccessLevel(VALID_USER, VALID_PAGE);
    expect(result).toEqual({ canView: true, canEdit: false, canShare: false, canDelete: false });
  });

  it('given MEMBER with custom role entry {canView:true, canEdit:true} on a PRIVATE page, returns canEdit too', async () => {
    const rolePerms = { [VALID_PAGE]: { canView: true, canEdit: true, canShare: false } };
    vi.mocked(db.select)
      .mockReturnValueOnce(mockSelectChainWithLeftJoin(makePageRow(true)))
      .mockReturnValueOnce(mockSelectChain([{ role: 'MEMBER', customRoleId: CUSTOM_ROLE_ID }]))
      .mockReturnValueOnce(mockSelectChain([]))
      .mockReturnValueOnce(mockSelectChain([{ permissions: rolePerms, driveWidePermissions: null }]));

    const result = await getUserAccessLevel(VALID_USER, VALID_PAGE);
    expect(result).toEqual({ canView: true, canEdit: true, canShare: false, canDelete: false });
  });

  it('given MEMBER with custom role entry {canView:true, canShare:true} on a PRIVATE page, returns canShare too', async () => {
    const rolePerms = { [VALID_PAGE]: { canView: true, canEdit: false, canShare: true } };
    vi.mocked(db.select)
      .mockReturnValueOnce(mockSelectChainWithLeftJoin(makePageRow(true)))
      .mockReturnValueOnce(mockSelectChain([{ role: 'MEMBER', customRoleId: CUSTOM_ROLE_ID }]))
      .mockReturnValueOnce(mockSelectChain([]))
      .mockReturnValueOnce(mockSelectChain([{ permissions: rolePerms, driveWidePermissions: null }]));

    const result = await getUserAccessLevel(VALID_USER, VALID_PAGE);
    expect(result).toEqual({ canView: true, canEdit: false, canShare: true, canDelete: false });
  });

  it('given MEMBER with custom role but NO entry for this PRIVATE page, returns null', async () => {
    const rolePerms = { 'other-page': { canView: true, canEdit: true, canShare: false } };
    vi.mocked(db.select)
      .mockReturnValueOnce(mockSelectChainWithLeftJoin(makePageRow(true)))
      .mockReturnValueOnce(mockSelectChain([{ role: 'MEMBER', customRoleId: CUSTOM_ROLE_ID }]))
      .mockReturnValueOnce(mockSelectChain([]))
      .mockReturnValueOnce(mockSelectChain([{ permissions: rolePerms, driveWidePermissions: null }]));

    const result = await getUserAccessLevel(VALID_USER, VALID_PAGE);
    expect(result).toBeNull();
  });

  it('given MEMBER with custom role but NO entry for this NON-PRIVATE page, returns read-only via Rule 4', async () => {
    const rolePerms = { 'other-page': { canView: true, canEdit: true, canShare: false } };
    vi.mocked(db.select)
      .mockReturnValueOnce(mockSelectChainWithLeftJoin(makePageRow(false)))
      .mockReturnValueOnce(mockSelectChain([{ role: 'MEMBER', customRoleId: CUSTOM_ROLE_ID }]))
      .mockReturnValueOnce(mockSelectChain([]))
      .mockReturnValueOnce(mockSelectChain([{ permissions: rolePerms, driveWidePermissions: null }]));

    const result = await getUserAccessLevel(VALID_USER, VALID_PAGE);
    expect(result).toEqual({ canView: true, canEdit: false, canShare: false, canDelete: false });
  });

  it('given MEMBER with custom role entry {canView:false} on a NON-PRIVATE page, denies (explicit deny beats Rule 4)', async () => {
    const rolePerms = { [VALID_PAGE]: { canView: false, canEdit: false, canShare: false } };
    vi.mocked(db.select)
      .mockReturnValueOnce(mockSelectChainWithLeftJoin(makePageRow(false)))
      .mockReturnValueOnce(mockSelectChain([{ role: 'MEMBER', customRoleId: CUSTOM_ROLE_ID }]))
      .mockReturnValueOnce(mockSelectChain([]))
      .mockReturnValueOnce(mockSelectChain([{ permissions: rolePerms, driveWidePermissions: null }]));

    const result = await getUserAccessLevel(VALID_USER, VALID_PAGE);
    expect(result).toBeNull();
  });

  it('given MEMBER with NO custom role on NON-PRIVATE page, returns read-only via Rule 4', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(mockSelectChainWithLeftJoin(makePageRow(false)))
      .mockReturnValueOnce(mockSelectChain([{ role: 'MEMBER', customRoleId: null }]))
      .mockReturnValueOnce(mockSelectChain([]));

    const result = await getUserAccessLevel(VALID_USER, VALID_PAGE);
    expect(result).toEqual({ canView: true, canEdit: false, canShare: false, canDelete: false });
  });

  it('given MEMBER with NO custom role on PRIVATE page, returns null', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(mockSelectChainWithLeftJoin(makePageRow(true)))
      .mockReturnValueOnce(mockSelectChain([{ role: 'MEMBER', customRoleId: null }]))
      .mockReturnValueOnce(mockSelectChain([]));

    const result = await getUserAccessLevel(VALID_USER, VALID_PAGE);
    expect(result).toBeNull();
  });

  it('given ADMIN, returns full access', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(mockSelectChainWithLeftJoin(makePageRow(true)))
      .mockReturnValueOnce(mockSelectChain([{ role: 'ADMIN', customRoleId: null }]));

    const result = await getUserAccessLevel(VALID_USER, VALID_PAGE);
    expect(result).toEqual({ canView: true, canEdit: true, canShare: true, canDelete: true });
  });

  it('given drive owner, returns full access', async () => {
    const ownerPage = [{ id: VALID_PAGE, driveId: VALID_DRIVE, driveOwnerId: VALID_USER, isPrivate: false }];
    vi.mocked(db.select)
      .mockReturnValueOnce(mockSelectChainWithLeftJoin(ownerPage));

    const result = await getUserAccessLevel(VALID_USER, VALID_PAGE);
    expect(result).toEqual({ canView: true, canEdit: true, canShare: true, canDelete: true });
  });

  it('given MEMBER with NO custom role on NON-PRIVATE CHANNEL page, returns canEdit:true', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(mockSelectChainWithLeftJoin(makePageRow(false, 'CHANNEL')))
      .mockReturnValueOnce(mockSelectChain([{ role: 'MEMBER', customRoleId: null }]))
      .mockReturnValueOnce(mockSelectChain([]));

    const result = await getUserAccessLevel(VALID_USER, VALID_PAGE);
    expect(result).toEqual({ canView: true, canEdit: true, canShare: false, canDelete: false });
  });

  it('given MEMBER with NO custom role on NON-PRIVATE non-CHANNEL page, returns canEdit:false', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(mockSelectChainWithLeftJoin(makePageRow(false, 'DOCUMENT')))
      .mockReturnValueOnce(mockSelectChain([{ role: 'MEMBER', customRoleId: null }]))
      .mockReturnValueOnce(mockSelectChain([]));

    const result = await getUserAccessLevel(VALID_USER, VALID_PAGE);
    expect(result).toEqual({ canView: true, canEdit: false, canShare: false, canDelete: false });
  });

  it('given explicit pagePermissions row, it beats custom role', async () => {
    const rolePerms = { [VALID_PAGE]: { canView: true, canEdit: false, canShare: false } };
    const explicitPerm = [{ canView: true, canEdit: true, canShare: true, canDelete: false }];
    vi.mocked(db.select)
      .mockReturnValueOnce(mockSelectChainWithLeftJoin(makePageRow(true)))
      .mockReturnValueOnce(mockSelectChain([{ role: 'MEMBER', customRoleId: CUSTOM_ROLE_ID }]))
      .mockReturnValueOnce(mockSelectChain(explicitPerm));

    const result = await getUserAccessLevel(VALID_USER, VALID_PAGE);
    expect(result).toEqual({ canView: true, canEdit: true, canShare: true, canDelete: false });
    expect(db.select).toHaveBeenCalledTimes(3);
  });
});
