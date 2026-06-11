import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: { select: vi.fn() },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', driveId: 'driveId', isPrivate: 'isPrivate', isTrashed: 'isTrashed', type: 'type' },
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  mcpTokens: { id: 'id', userId: 'userId' },
}));
vi.mock('@pagespace/db/schema/members', () => ({
  mcpTokenDrives: {
    id: 'id',
    tokenId: 'tokenId',
    driveId: 'driveId',
    role: 'role',
    customRoleId: 'customRoleId',
  },
  driveRoles: {
    id: 'id',
    driveId: 'driveId',
    permissions: 'permissions',
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((_a: unknown, _b: unknown) => 'eq'),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  inArray: vi.fn((_a: unknown, _b: unknown) => 'inArray'),
}));
// User-side oracle, mocked: inherit MUST delegate to these with the OWNER's id.
vi.mock('../permissions', () => ({
  getUserAccessLevel: vi.fn(),
  isUserDriveMember: vi.fn(),
  getUserAccessiblePagesInDriveWithDetails: vi.fn(),
}));

import {
  getAppAccessLevel,
  hasAppDriveMembership,
  getAppDriveMembership,
  getAppDriveAccessLevel,
  getAppAccessiblePagesInDrive,
  resolveExplicitAppRoleAccess,
} from '../app-permissions';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import {
  getUserAccessLevel,
  isUserDriveMember,
  getUserAccessiblePagesInDriveWithDetails,
} from '../permissions';

const TOKEN_ID = 'mcp_aaaaaaaaaaaaaaaaaaaaaa';
const OWNER_ID = 'user_oooooooooooooooooooo';
const PAGE_ID = 'page_bbbbbbbbbbbbbbbbbbbbbbb';
const DRIVE_ID = 'drive_cccccccccccccccccccccc';
const CUSTOM_ROLE_ID = 'role_dddddddddddddddddddddd';

const FULL = { canView: true, canEdit: true, canShare: true, canDelete: true };
const VIEW_ONLY = { canView: true, canEdit: false, canShare: false, canDelete: false };
const NONE = { canView: false, canEdit: false, canShare: false, canDelete: false };

// select().from().where().limit() → rows  (page target, custom role)
function stubSelect(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as unknown as ReturnType<typeof db.select>;
}

// select().from().innerJoin().where().limit() → rows  (membership + owner join)
function stubSelectJoin(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows),
        }),
      }),
    }),
  } as unknown as ReturnType<typeof db.select>;
}

// select().from().where() → rows  (page enumeration)
function stubSelectList(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  } as unknown as ReturnType<typeof db.select>;
}

const membershipRow = (role: 'OWNER' | 'ADMIN' | 'MEMBER' | null, customRoleId: string | null = null) =>
  ({ role, customRoleId, ownerUserId: OWNER_ID });

// ---------------------------------------------------------------------------
// Pure parity resolver — table-driven, ZERO mocks. The oracle is
// getUserAccessLevel's member semantics (permissions.ts:92-280).
// ---------------------------------------------------------------------------

describe('resolveExplicitAppRoleAccess (pure user-parity table)', () => {
  const base = {
    customRole: null,
    customRoleUnresolved: false,
    targetPageId: PAGE_ID,
    isDriveRoot: false,
  };

  it.each([
    // [description, input, expected]
    ['MEMBER on non-private DOCUMENT → view-only', { role: 'MEMBER', pageType: 'DOCUMENT', isPrivate: false }, VIEW_ONLY],
    ['MEMBER on non-private CHANNEL → canEdit (Discord/Slack member posting)', { role: 'MEMBER', pageType: 'CHANNEL', isPrivate: false }, { ...VIEW_ONLY, canEdit: true }],
    ['MEMBER on private page → null (no access)', { role: 'MEMBER', pageType: 'DOCUMENT', isPrivate: true }, null],
    ['ADMIN on private page → full (admins see private, same as user admins)', { role: 'ADMIN', pageType: 'DOCUMENT', isPrivate: true }, FULL],
    ['OWNER on CHANNEL → full', { role: 'OWNER', pageType: 'CHANNEL', isPrivate: false }, FULL],
  ] as const)('%s', (_desc, input, expected) => {
    expect(resolveExplicitAppRoleAccess({ ...base, ...input })).toEqual(expected);
  });

  it.each([
    ['MEMBER at drive root → view+edit (members may create root pages)', 'MEMBER', { canView: true, canEdit: true, canShare: false, canDelete: false }],
    ['ADMIN at drive root → full', 'ADMIN', FULL],
  ] as const)('%s', (_desc, role, expected) => {
    expect(
      resolveExplicitAppRoleAccess({ ...base, role, pageType: null, isPrivate: false, isDriveRoot: true }),
    ).toEqual(expected);
  });

  it('custom role per-page grant wins; canDelete forced false', () => {
    expect(
      resolveExplicitAppRoleAccess({
        ...base,
        role: 'MEMBER',
        customRole: { permissions: { [PAGE_ID]: { canView: true, canEdit: true, canShare: false } }, driveWidePermissions: null },
        pageType: 'DOCUMENT',
        isPrivate: false,
      }),
    ).toEqual({ canView: true, canEdit: true, canShare: false, canDelete: false });
  });

  it('custom role driveWide fallback never grants PRIVATE pages', () => {
    expect(
      resolveExplicitAppRoleAccess({
        ...base,
        role: 'MEMBER',
        customRole: { permissions: {}, driveWidePermissions: { canView: true, canEdit: false, canShare: false } },
        pageType: 'DOCUMENT',
        isPrivate: true,
      }),
    ).toBeNull();
  });

  it('custom role with no grant for the page → all-false (explicit-list semantics)', () => {
    expect(
      resolveExplicitAppRoleAccess({
        ...base,
        role: 'MEMBER',
        customRole: { permissions: { other: { canView: true, canEdit: false, canShare: false } }, driveWidePermissions: null },
        pageType: 'DOCUMENT',
        isPrivate: false,
      }),
    ).toEqual(NONE);
  });

  it('custom role id set but unresolvable → all-false', () => {
    expect(
      resolveExplicitAppRoleAccess({
        ...base,
        role: 'MEMBER',
        customRoleUnresolved: true,
        pageType: 'DOCUMENT',
        isPrivate: false,
      }),
    ).toEqual(NONE);
  });
});

// ---------------------------------------------------------------------------
// getAppAccessLevel — dispatch: inherit → owner's access; explicit → resolver
// ---------------------------------------------------------------------------

describe('getAppAccessLevel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when token has no membership in the drive', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ driveId: DRIVE_ID, isPrivate: false, type: 'DOCUMENT' }]))
      .mockReturnValueOnce(stubSelectJoin([]));

    expect(await getAppAccessLevel(TOKEN_ID, PAGE_ID)).toBeNull();
    expect(getUserAccessLevel).not.toHaveBeenCalled();
  });

  it('INHERIT (role null) → delegates to the OWNER\'s user access for the page', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ driveId: DRIVE_ID, isPrivate: false, type: 'DOCUMENT' }]))
      .mockReturnValueOnce(stubSelectJoin([membershipRow(null)]));
    vi.mocked(getUserAccessLevel).mockResolvedValue(FULL);

    expect(await getAppAccessLevel(TOKEN_ID, PAGE_ID)).toEqual(FULL);
    expect(getUserAccessLevel).toHaveBeenCalledWith(OWNER_ID, PAGE_ID);
  });

  it('explicit MEMBER on a CHANNEL → canEdit true (parity, end to end)', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ driveId: DRIVE_ID, isPrivate: false, type: 'CHANNEL' }]))
      .mockReturnValueOnce(stubSelectJoin([membershipRow('MEMBER')]));

    expect(await getAppAccessLevel(TOKEN_ID, PAGE_ID)).toEqual({ ...VIEW_ONLY, canEdit: true });
    expect(getUserAccessLevel).not.toHaveBeenCalled();
  });

  it('explicit MEMBER on a private page → null', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ driveId: DRIVE_ID, isPrivate: true, type: 'DOCUMENT' }]))
      .mockReturnValueOnce(stubSelectJoin([membershipRow('MEMBER')]));

    expect(await getAppAccessLevel(TOKEN_ID, PAGE_ID)).toBeNull();
  });

  it('drive-as-root target (no page row): explicit MEMBER may create (view+edit)', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([]))
      .mockReturnValueOnce(stubSelectJoin([membershipRow('MEMBER')]));

    expect(await getAppAccessLevel(TOKEN_ID, DRIVE_ID)).toEqual({
      canView: true, canEdit: true, canShare: false, canDelete: false,
    });
  });

  it('explicit custom role resolves through fetchCustomRolePermissions', async () => {
    const perms = { [PAGE_ID]: { canView: true, canEdit: true, canShare: false } };
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ driveId: DRIVE_ID, isPrivate: false, type: 'DOCUMENT' }]))
      .mockReturnValueOnce(stubSelectJoin([membershipRow('MEMBER', CUSTOM_ROLE_ID)]))
      .mockReturnValueOnce(stubSelect([{ permissions: perms, driveWidePermissions: null }]));

    expect(await getAppAccessLevel(TOKEN_ID, PAGE_ID)).toEqual({
      canView: true, canEdit: true, canShare: false, canDelete: false,
    });
  });
});

// ---------------------------------------------------------------------------
// hasAppDriveMembership — dangling-inherit denial (Story 5)
// ---------------------------------------------------------------------------

describe('hasAppDriveMembership', () => {
  beforeEach(() => vi.clearAllMocks());

  it('false when no row', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubSelectJoin([]));
    expect(await hasAppDriveMembership(TOKEN_ID, DRIVE_ID)).toBe(false);
  });

  it('explicit role row → true regardless of owner membership', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubSelectJoin([membershipRow('MEMBER')]));
    expect(await hasAppDriveMembership(TOKEN_ID, DRIVE_ID)).toBe(true);
    expect(isUserDriveMember).not.toHaveBeenCalled();
  });

  it('inherit row counts ONLY while the owner still has drive access', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubSelectJoin([membershipRow(null)]));
    vi.mocked(isUserDriveMember).mockResolvedValue(true);
    expect(await hasAppDriveMembership(TOKEN_ID, DRIVE_ID)).toBe(true);
    expect(isUserDriveMember).toHaveBeenCalledWith(OWNER_ID, DRIVE_ID);
  });

  it('DANGLING inherit row (owner removed) → false', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubSelectJoin([membershipRow(null)]));
    vi.mocked(isUserDriveMember).mockResolvedValue(false);
    expect(await hasAppDriveMembership(TOKEN_ID, DRIVE_ID)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getAppDriveMembership / getAppDriveAccessLevel
// ---------------------------------------------------------------------------

describe('getAppDriveMembership', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns nullable role + ownerUserId', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubSelectJoin([membershipRow(null)]));
    expect(await getAppDriveMembership(TOKEN_ID, DRIVE_ID)).toEqual({
      role: null, customRoleId: null, ownerUserId: OWNER_ID,
    });
  });

  it('returns null when no membership row', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubSelectJoin([]));
    expect(await getAppDriveMembership(TOKEN_ID, DRIVE_ID)).toBeNull();
  });
});

describe('getAppDriveAccessLevel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('null when token has no membership', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubSelectJoin([]));
    expect(await getAppDriveAccessLevel(TOKEN_ID, DRIVE_ID)).toBeNull();
  });

  it('INHERIT → owner\'s drive-root access via getUserAccessLevel', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubSelectJoin([membershipRow(null)]));
    vi.mocked(getUserAccessLevel).mockResolvedValue(FULL);
    expect(await getAppDriveAccessLevel(TOKEN_ID, DRIVE_ID)).toEqual(FULL);
    expect(getUserAccessLevel).toHaveBeenCalledWith(OWNER_ID, DRIVE_ID);
  });

  it('explicit MEMBER → view+edit (user drive-root parity: members create root pages/events)', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubSelectJoin([membershipRow('MEMBER')]));
    expect(await getAppDriveAccessLevel(TOKEN_ID, DRIVE_ID)).toEqual({
      canView: true, canEdit: true, canShare: false, canDelete: false,
    });
  });

  it('explicit ADMIN → full', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubSelectJoin([membershipRow('ADMIN')]));
    expect(await getAppDriveAccessLevel(TOKEN_ID, DRIVE_ID)).toEqual(FULL);
  });
});

// ---------------------------------------------------------------------------
// getAppAccessiblePagesInDrive
// ---------------------------------------------------------------------------

describe('getAppAccessiblePagesInDrive', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns [] when the token has no membership', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubSelectJoin([]));
    expect(await getAppAccessiblePagesInDrive(TOKEN_ID, DRIVE_ID)).toEqual([]);
  });

  it('INHERIT → exactly the owner\'s accessible set', async () => {
    const ownerSet = [
      { id: 'p1', title: 'A', type: 'DOCUMENT', parentId: null, position: 0, isTrashed: false, permissions: FULL },
    ];
    vi.mocked(db.select).mockReturnValueOnce(stubSelectJoin([membershipRow(null)]));
    vi.mocked(getUserAccessiblePagesInDriveWithDetails).mockResolvedValue(ownerSet);

    expect(await getAppAccessiblePagesInDrive(TOKEN_ID, DRIVE_ID)).toBe(ownerSet);
    expect(getUserAccessiblePagesInDriveWithDetails).toHaveBeenCalledWith(OWNER_ID, DRIVE_ID);
  });

  it('explicit plain MEMBER: non-private pages, channels editable', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelectJoin([membershipRow('MEMBER')]))
      .mockReturnValueOnce(stubSelectList([
        { id: 'doc', title: 'Doc', type: 'DOCUMENT', parentId: null, position: 0, isTrashed: false },
        { id: 'chan', title: 'General', type: 'CHANNEL', parentId: null, position: 1, isTrashed: false },
      ]));

    const result = await getAppAccessiblePagesInDrive(TOKEN_ID, DRIVE_ID);
    expect(result.find((p) => p.id === 'doc')?.permissions).toEqual(VIEW_ONLY);
    expect(result.find((p) => p.id === 'chan')?.permissions).toEqual({ ...VIEW_ONLY, canEdit: true });
    expect(eq).toHaveBeenCalledWith('isPrivate', false);
  });

  it('explicit ADMIN: every page, full access', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelectJoin([membershipRow('ADMIN')]))
      .mockReturnValueOnce(stubSelectList([
        { id: 'p1', title: 'A', type: 'DOCUMENT', parentId: null, position: 0, isTrashed: false },
      ]));

    const result = await getAppAccessiblePagesInDrive(TOKEN_ID, DRIVE_ID);
    expect(result).toHaveLength(1);
    expect(result[0].permissions).toEqual(FULL);
  });

  it('explicit custom role without drive-wide view → only granted pages', async () => {
    const perms = {
      p1: { canView: true, canEdit: true, canShare: false },
      p2: { canView: false, canEdit: false, canShare: false },
    };
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelectJoin([membershipRow('MEMBER', CUSTOM_ROLE_ID)]))
      .mockReturnValueOnce(stubSelect([{ permissions: perms, driveWidePermissions: null }]))
      .mockReturnValueOnce(stubSelectList([
        { id: 'p1', title: 'A', type: 'DOCUMENT', parentId: null, position: 0, isTrashed: false },
      ]));

    const result = await getAppAccessiblePagesInDrive(TOKEN_ID, DRIVE_ID);
    expect(result).toHaveLength(1);
    expect(result[0].permissions).toEqual({ canView: true, canEdit: true, canShare: false, canDelete: false });
  });
});
