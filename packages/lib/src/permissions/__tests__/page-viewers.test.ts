/**
 * getUsersWhoCanViewPage without a database: the query is stubbed and the rows
 * go through the real resolvePagePermissionRow, so these cases pin what the
 * fan-out paths (channel inbox, mentions) decide for a given membership shape.
 * page-viewers.integration.test.ts covers the joins against real Postgres.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: { select: vi.fn() },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', driveId: 'driveId', isTrashed: 'isTrashed', isPrivate: 'isPrivate', type: 'type' },
  drives: { id: 'id', ownerId: 'ownerId' },
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'users.id' },
}));
vi.mock('@pagespace/db/schema/members', () => ({
  driveMembers: { driveId: 'driveId', userId: 'userId', role: 'role', acceptedAt: 'acceptedAt', customRoleId: 'customRoleId' },
  pagePermissions: {
    pageId: 'pageId', userId: 'userId', canView: 'canView', canEdit: 'canEdit',
    canShare: 'canShare', canDelete: 'canDelete', expiresAt: 'expiresAt',
  },
  driveRoles: { id: 'id', driveId: 'driveId', permissions: 'permissions', driveWidePermissions: 'driveWidePermissions' },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(() => 'eq'),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  isNull: vi.fn((a: unknown) => ({ isNull: a })),
  isNotNull: vi.fn((a: unknown) => ({ isNotNull: a })),
  gt: vi.fn((a: unknown, b: unknown) => ({ gt: { a, b } })),
  inArray: vi.fn((a: unknown, b: unknown) => ({ inArray: { a, b } })),
}));
vi.mock('../../logging/logger-config', () => ({
  loggers: { api: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } },
}));

import { db } from '@pagespace/db/db';
import { getUsersWhoCanViewPage, type PagePermissionRow } from '../permissions';

type ViewerRow = PagePermissionRow & { userId: string };

const viewerRow = (userId: string, overrides: Partial<PagePermissionRow> = {}): ViewerRow => ({
  userId,
  pageId: 'page_private',
  isTrashed: false,
  isPrivate: true,
  pageType: 'CHANNEL',
  driveOwnerId: 'owner',
  memberRole: 'MEMBER',
  explicitCanView: null,
  explicitCanEdit: null,
  explicitCanShare: null,
  explicitCanDelete: null,
  customRolePerms: null,
  customRoleDriveWidePerms: null,
  ...overrides,
});

// db.select().from().innerJoin().leftJoin() x4 .where() → rows
function stubRows(rows: ViewerRow[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const chain: { leftJoin: ReturnType<typeof vi.fn>; where: typeof where } = { leftJoin: vi.fn(), where };
  chain.leftJoin.mockReturnValue(chain);
  const from = vi.fn().mockReturnValue({ innerJoin: vi.fn().mockReturnValue(chain) });
  vi.mocked(db.select).mockReturnValueOnce({ from } as unknown as ReturnType<typeof db.select>);
}

describe('getUsersWhoCanViewPage — custom role drive-wide grant on a private page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('leaves out a member whose role has drive-wide canView but no entry for the private page', async () => {
    stubRows([
      viewerRow('drive_wide_only', {
        customRolePerms: {},
        customRoleDriveWidePerms: { canView: true, canEdit: true, canShare: true },
      }),
    ]);

    await expect(getUsersWhoCanViewPage('page_private', ['drive_wide_only'])).resolves.toEqual(new Set());
  });

  it('includes a member whose role has a per-page entry for the private page', async () => {
    stubRows([
      viewerRow('per_page_entry', {
        customRolePerms: { page_private: { canView: true, canEdit: false, canShare: false } },
        customRoleDriveWidePerms: { canView: false, canEdit: false, canShare: false },
      }),
    ]);

    await expect(getUsersWhoCanViewPage('page_private', ['per_page_entry'])).resolves.toEqual(new Set(['per_page_entry']));
  });

  it('still includes the owner, and a drive-wide member of a NON-private page', async () => {
    stubRows([
      viewerRow('owner'),
      viewerRow('drive_wide_public', {
        isPrivate: false,
        customRolePerms: {},
        customRoleDriveWidePerms: { canView: true, canEdit: false, canShare: false },
      }),
    ]);

    await expect(getUsersWhoCanViewPage('page_private', ['owner', 'drive_wide_public'])).resolves.toEqual(
      new Set(['owner', 'drive_wide_public']),
    );
  });
});
