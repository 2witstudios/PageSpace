import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: { select: vi.fn(), transaction: vi.fn() },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a, b) => ['eq', a, b]),
  and: vi.fn((...c) => ['and', ...c]),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { __table: 'pages', id: 'pages.id', driveId: 'pages.driveId' },
  drives: { __table: 'drives', id: 'drives.id', ownerId: 'drives.ownerId' },
}));
vi.mock('@pagespace/db/schema/members', () => ({
  driveMembers: {
    __table: 'driveMembers',
    driveId: 'driveMembers.driveId',
    userId: 'driveMembers.userId',
    role: 'driveMembers.role',
    acceptedAt: 'driveMembers.acceptedAt',
  },
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  isDriveOwnerOrAdmin: vi.fn(async () => false),
}));
vi.mock('@pagespace/lib/pages/circular-reference-guard', () => ({
  validatePageMove: vi.fn(),
}));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn(async () => ({ actorEmail: 'a@example.com', actorDisplayName: 'A' })),
}));
vi.mock('../page-mutation-service', () => ({
  applyPageMutation: vi.fn(async () => ({})),
}));
vi.mock('../task-sync-service', () => ({
  syncTaskItemOnMove: vi.fn(async () => undefined),
}));

import { db } from '@pagespace/db/db';
import { isDriveOwnerOrAdmin } from '@pagespace/lib/permissions/permissions';
import { applyPageMutation } from '../page-mutation-service';
import { pageReorderService } from '../page-reorder-service';

type MockFn = ReturnType<typeof vi.fn>;
type MemberRow = { driveId: string; userId: string; role: string; acceptedAt: Date | null };
type Predicate = [string, ...unknown[]];

const mockDb = db as unknown as { select: MockFn; transaction: MockFn };

const column = (ref: unknown) => String(ref).replace(/^driveMembers\./, '') as keyof MemberRow;
const matches = (row: MemberRow, p: Predicate): boolean => {
  const [op, ...args] = p;
  if (op === 'and') return (args as Predicate[]).every((arg) => matches(row, arg));
  if (op === 'eq') return row[column(args[0])] === args[1];
  throw new Error(`fake table cannot evaluate ${JSON.stringify(p)}`);
};

/**
 * reorderPage used to decide "owner or admin" with its own drive_members read
 * that filtered on role ADMIN but not acceptedAt, so a pending ADMIN invitee
 * could reorder and re-parent pages in a drive they had never joined.
 *
 * The drive_members fake below answers any query the service builds against
 * the seeded row; the canonical isDriveOwnerOrAdmin mock answers what
 * permissions.ts answers for that row (pending → false, accepted → true).
 */
function seed(row: MemberRow, canonicalAnswer: boolean) {
  vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(canonicalAnswer);
  const pageInfo = { driveId: 'drive-1', title: 'Page', ownerId: 'owner-1', revision: 3, type: 'DOCUMENT', parentId: null };
  mockDb.select.mockImplementation(() => ({
    from: (table: { __table: string }) => {
      if (table.__table === 'pages') {
        return { leftJoin: () => ({ where: () => ({ limit: async () => [pageInfo] }) }) };
      }
      if (table.__table === 'driveMembers') {
        return { where: (where: Predicate) => ({ limit: async () => [row].filter((r) => matches(r, where)) }) };
      }
      throw new Error(`unexpected select from ${table.__table}`);
    },
  }));
  mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => cb({}));
}

const reorder = (userId: string) =>
  pageReorderService.reorderPage({ pageId: 'page-1', newParentId: null, newPosition: 1, userId });

describe('pageReorderService.reorderPage — pending invites', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['ADMIN', 'MEMBER'])('refuses a user whose %s invite is still pending', async (role) => {
    seed({ driveId: 'drive-1', userId: 'user-1', role, acceptedAt: null }, false);

    const result = await reorder('user-1');

    expect(result).toEqual({ success: false, error: 'Only drive owners and admins can reorder pages.', status: 403 });
    expect(applyPageMutation).not.toHaveBeenCalled();
  });

  it('allows the same user once the ADMIN invite is accepted', async () => {
    seed({ driveId: 'drive-1', userId: 'user-1', role: 'ADMIN', acceptedAt: new Date('2026-09-01') }, true);

    const result = await reorder('user-1');

    expect(result).toEqual({ success: true, driveId: 'drive-1', pageTitle: 'Page' });
    expect(isDriveOwnerOrAdmin).toHaveBeenCalledWith('user-1', 'drive-1');
    expect(applyPageMutation).toHaveBeenCalledTimes(1);
  });

  it('refuses an accepted MEMBER', async () => {
    seed({ driveId: 'drive-1', userId: 'user-1', role: 'MEMBER', acceptedAt: new Date('2026-09-01') }, false);

    const result = await reorder('user-1');

    expect(result).toMatchObject({ success: false, status: 403 });
    expect(applyPageMutation).not.toHaveBeenCalled();
  });

  it('allows the drive owner', async () => {
    seed({ driveId: 'drive-1', userId: 'someone-else', role: 'MEMBER', acceptedAt: new Date('2026-09-01') }, true);

    const result = await reorder('owner-1');

    expect(result).toMatchObject({ success: true });
    expect(applyPageMutation).toHaveBeenCalledTimes(1);
  });

  it('refuses a non-member', async () => {
    seed({ driveId: 'drive-1', userId: 'someone-else', role: 'ADMIN', acceptedAt: new Date('2026-09-01') }, false);

    const result = await reorder('user-1');

    expect(result).toMatchObject({ success: false, status: 403 });
    expect(applyPageMutation).not.toHaveBeenCalled();
  });
});

describe('pageReorderService.reorderPage — org drives (B7c)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('X-6 (partial) a stale source=org ADMIN row reorders nothing: the org-aware isDriveOwnerOrAdmin refuses, and the service reads no drive_members row of its own', async () => {
    seed({ driveId: 'drive-1', userId: 'user-1', role: 'ADMIN', acceptedAt: new Date('2026-09-01') }, false);
    const fromTables: string[] = [];
    const inner = mockDb.select.getMockImplementation() as () => { from: (t: { __table: string }) => unknown };
    mockDb.select.mockImplementation(() => ({ from: (t: { __table: string }) => { fromTables.push(t.__table); return inner().from(t); } }));

    const result = await reorder('user-1');

    expect(result).toMatchObject({ success: false, status: 403 });
    expect(fromTables).toContain('pages');
    expect(fromTables).not.toContain('driveMembers');
    expect(applyPageMutation).not.toHaveBeenCalled();
  });

  it('ORG-4 (partial) an org Admin with no drive_members row reorders pages, because isDriveOwnerOrAdmin answers ADMIN through org power', async () => {
    seed({ driveId: 'drive-1', userId: 'someone-else', role: 'MEMBER', acceptedAt: new Date('2026-09-01') }, true);

    const result = await reorder('org-admin-1');

    expect(result).toMatchObject({ success: true });
    expect(isDriveOwnerOrAdmin).toHaveBeenCalledWith('org-admin-1', 'drive-1');
  });
});
