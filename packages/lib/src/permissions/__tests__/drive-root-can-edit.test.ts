/**
 * getUserAccessLevel — drive-as-root fallback (#2627).
 *
 * Root-level page create treats the drive id as the parent id, so this
 * fallback IS the root-create authorization for session users (createPage ->
 * canUserEditPage -> getUserAccessLevel). It must bound a MEMBER's drive-wide
 * edit by their custom role exactly like getUserDrivePermissions and the
 * token resolvers (getAppAccessLevel / getScopedAccessLevel) already do —
 * one rule everywhere.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(),
  },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'pages.id', driveId: 'pages.driveId', isPrivate: 'pages.isPrivate', type: 'pages.type' },
  drives: { id: 'drives.id', ownerId: 'drives.ownerId' },
}));
vi.mock('@pagespace/db/schema/members', () => ({
  driveMembers: {
    driveId: 'driveMembers.driveId',
    userId: 'driveMembers.userId',
    role: 'driveMembers.role',
    id: 'driveMembers.id',
    acceptedAt: 'driveMembers.acceptedAt',
    customRoleId: 'driveMembers.customRoleId',
  },
  pagePermissions: {
    pageId: 'pagePermissions.pageId',
    userId: 'pagePermissions.userId',
    canView: 'pagePermissions.canView',
  },
  driveRoles: {
    id: 'driveRoles.id',
    driveId: 'driveRoles.driveId',
    permissions: 'driveRoles.permissions',
    driveWidePermissions: 'driveRoles.driveWidePermissions',
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((_a: unknown, _b: unknown) => 'eq'),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  isNull: vi.fn((a: unknown) => ({ isNull: a })),
  isNotNull: vi.fn((a: unknown) => ({ isNotNull: a })),
  inArray: vi.fn((a: unknown, b: unknown) => ({ inArray: { a, b } })),
}));
vi.mock('../../logging/logger-config', () => ({
  loggers: {
    api: { debug: vi.fn(), error: vi.fn() },
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
const VALID_DRIVE = 'clzzzzzzzzzzzzzzzzzzzzzzz';
const CUSTOM_ROLE_ID = 'clrolexxxxxxxxxxxxxxxxxx';

function mockValidators() {
  vi.mocked(parseUserId).mockReturnValue({ success: true, data: VALID_USER });
  // The drive id rides through the page-id validator into the queries.
  vi.mocked(parsePageId).mockReturnValue({ success: true, data: VALID_DRIVE });
}

function chain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
    }),
  } as unknown as ReturnType<typeof db.select>;
}

function pageChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      leftJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
      }),
    }),
  } as unknown as ReturnType<typeof db.select>;
}

/**
 * Queue the drive-as-root query ladder: page lookup (miss), drive lookup,
 * membership lookup, then the custom-role lookup (only consumed when the
 * membership carries a customRoleId).
 */
function driveAsRoot(membership: unknown, roleRows: unknown[] = []) {
  vi.mocked(db.select)
    .mockReturnValueOnce(pageChain([]))
    .mockReturnValueOnce(chain([{ id: VALID_DRIVE, ownerId: 'other-owner' }]))
    .mockReturnValueOnce(chain(Array.isArray(membership) ? membership : [membership]))
    .mockReturnValueOnce(chain(roleRows));
}

describe('getUserAccessLevel — drive-as-root custom-role bounding (#2627)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The custom-role chain is only consumed once the implementation exists,
    // so drop any leftover queued chains between tests (clearAllMocks keeps
    // the mockReturnValueOnce queue, which would bleed into the next test).
    vi.mocked(db.select).mockReset();
    mockValidators();
  });

  it('given a plain MEMBER with no custom role, should grant drive-wide edit', async () => {
    driveAsRoot({ role: 'MEMBER', customRoleId: null });
    const result = await getUserAccessLevel(VALID_USER, VALID_DRIVE);
    expect(result).toEqual({ canView: true, canEdit: true, canShare: false, canDelete: false });
  });

  it('given a MEMBER with a view-only custom role, should deny drive-wide edit', async () => {
    driveAsRoot(
      { role: 'MEMBER', customRoleId: CUSTOM_ROLE_ID },
      [{ id: CUSTOM_ROLE_ID, driveId: VALID_DRIVE, permissions: {}, driveWidePermissions: { canView: true, canEdit: false, canShare: false } }],
    );
    const result = await getUserAccessLevel(VALID_USER, VALID_DRIVE);
    expect(result).toEqual({ canView: true, canEdit: false, canShare: false, canDelete: false });
  });

  it('given a MEMBER whose custom role grants drive-wide edit, should grant edit', async () => {
    driveAsRoot(
      { role: 'MEMBER', customRoleId: CUSTOM_ROLE_ID },
      [{ id: CUSTOM_ROLE_ID, driveId: VALID_DRIVE, permissions: {}, driveWidePermissions: { canView: true, canEdit: true, canShare: false } }],
    );
    const result = await getUserAccessLevel(VALID_USER, VALID_DRIVE);
    expect(result).toEqual({ canView: true, canEdit: true, canShare: false, canDelete: false });
  });

  it('given a MEMBER whose custom role belongs to another drive, should deny drive-wide edit', async () => {
    driveAsRoot(
      { role: 'MEMBER', customRoleId: CUSTOM_ROLE_ID },
      [{ id: CUSTOM_ROLE_ID, driveId: 'clotherdrivexxxxxxxxxxxxx', permissions: {}, driveWidePermissions: { canView: true, canEdit: true, canShare: false } }],
    );
    const result = await getUserAccessLevel(VALID_USER, VALID_DRIVE);
    expect(result).toEqual({ canView: true, canEdit: false, canShare: false, canDelete: false });
  });

  it('given a MEMBER with an unresolvable custom role, should fail closed (deny edit)', async () => {
    driveAsRoot({ role: 'MEMBER', customRoleId: CUSTOM_ROLE_ID }, []);
    const result = await getUserAccessLevel(VALID_USER, VALID_DRIVE);
    expect(result).toEqual({ canView: true, canEdit: false, canShare: false, canDelete: false });
  });

  it('given an ADMIN, should grant full access regardless of a custom role', async () => {
    driveAsRoot({ role: 'ADMIN', customRoleId: CUSTOM_ROLE_ID });
    const result = await getUserAccessLevel(VALID_USER, VALID_DRIVE);
    expect(result).toEqual({ canView: true, canEdit: true, canShare: true, canDelete: true });
  });

  it('given no membership at all, should return null', async () => {
    driveAsRoot([]);
    const result = await getUserAccessLevel(VALID_USER, VALID_DRIVE);
    expect(result).toBeNull();
  });
});
