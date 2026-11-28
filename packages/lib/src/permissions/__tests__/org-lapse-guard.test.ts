/**
 * [D-OW-33] the drive lapse guard, unit level: which rows each scope reads, that the baseline is read FOR UPDATE under
 * the per-drive advisory lock, and that every helper ends in checkOrgMayLoosen. The real-Postgres behaviour (refusal,
 * savepoint, race) is in organizations/__tests__/org-lapse-loosening.integration.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveAgentMembers, driveMembers, driveRoles, mcpTokenDrives, pagePermissions } from '@pagespace/db/schema/members';

const checkOrgMayLoosen = vi.hoisted(() => vi.fn());
vi.mock('../../organizations/status', () => ({
  checkOrgMayLoosen,
  ORG_LAPSED_CODE: 'org_lapsed',
  ORG_LAPSED_MESSAGE: 'lapsed copy',
}));
vi.mock('@pagespace/db/db', () => ({ db: {} }));

import {
  OrgLapsedError,
  checkDriveMayLoosen,
  checkPageMayLoosen,
  driveAccessLockKey,
  guardDriveAccess,
  isOrgLapsedError,
  snapshotDriveAccess,
} from '../org-lapse-guard';

const LAPSED = { ok: false, code: 'org_lapsed', status: 402, message: 'lapsed copy' };

type Rows = Map<unknown, Array<Record<string, unknown>>>;

/** A query-builder stand-in: each select resolves to the rows given for its table and records what it was asked. */
function fakeExecutor(rows: Rows) {
  const reads: Array<{ table: unknown; locked: boolean }> = [];
  const executed: unknown[] = [];
  const executor = {
    select: () => {
      const state = { table: undefined as unknown, locked: false };
      const builder = {
        from(table: unknown) { state.table = table; return builder; },
        innerJoin() { return builder; },
        where() { return builder; },
        limit() { return builder; },
        for() { state.locked = true; return builder; },
        then(resolve: (r: unknown) => void, reject: (e: unknown) => void) {
          reads.push({ table: state.table, locked: state.locked });
          Promise.resolve(rows.get(state.table) ?? []).then(resolve, reject);
        },
      };
      return builder;
    },
    execute: async (q: unknown) => { executed.push(q); return []; },
    transaction: async <T,>(fn: (tx: unknown) => Promise<T>) => fn(executor),
  };
  return { executor, reads, executed };
}

const drive = (over: Record<string, unknown> = {}) => [{ ownerId: 'lead', orgId: 'org', orgVisibility: 'RESTRICTED', ...over }];

beforeEach(() => {
  vi.clearAllMocks();
  checkOrgMayLoosen.mockResolvedValue(null);
});

describe('checkDriveMayLoosen / checkPageMayLoosen', () => {
  it('SEAT-9 (partial) [D-OW-33] read nothing when the change does not loosen; a personal drive or page is never refused; an org drive asks checkOrgMayLoosen', async () => {
    const { executor, reads } = fakeExecutor(new Map<unknown, Array<Record<string, unknown>>>([[drives, drive()]]));
    expect(await checkDriveMayLoosen(executor as never, 'd1', false)).toBeNull();
    expect(await checkPageMayLoosen(executor as never, 'p1', false)).toBeNull();
    expect(reads).toHaveLength(0);

    checkOrgMayLoosen.mockResolvedValue(LAPSED);
    expect(await checkDriveMayLoosen(executor as never, 'd1', true)).toEqual(LAPSED);
    expect(checkOrgMayLoosen).toHaveBeenCalledWith(executor, 'org', true);

    const personal = fakeExecutor(new Map<unknown, Array<Record<string, unknown>>>([[drives, drive({ orgId: null })], [pages, [{ orgId: null }]]]));
    expect(await checkDriveMayLoosen(personal.executor as never, 'd1', true)).toBeNull();
    expect(await checkPageMayLoosen(personal.executor as never, 'p1', true)).toBeNull();
    const missing = fakeExecutor(new Map());
    expect(await checkDriveMayLoosen(missing.executor as never, 'd1', true)).toBeNull();
    expect(await checkPageMayLoosen(missing.executor as never, 'p1', true)).toBeNull();

    // A page's org comes from pages ⋈ drives (the fake answers the FROM table).
    const orgPage = fakeExecutor(new Map<unknown, Array<Record<string, unknown>>>([[pages, [{ orgId: 'org' }]]]));
    expect(await checkPageMayLoosen(orgPage.executor as never, 'p1', true)).toEqual(LAPSED);
  });
});

describe('snapshotDriveAccess', () => {
  const full: Rows = new Map<unknown, Array<Record<string, unknown>>>([
    [drives, drive()],
    [driveRoles, [{ id: 'r1', permissions: null, driveWide: null, isDefault: true }]],
    [driveMembers, [{ userId: 'u1', role: 'ADMIN', customRoleId: null, acceptedAt: new Date() }, { userId: 'u2', role: 'WEIRD', customRoleId: 'r1', acceptedAt: null }]],
    [pagePermissions, [{ pageId: 'p1', userId: 'u1', canView: true, canEdit: false, canShare: false, canDelete: false }]],
    [driveAgentMembers, [{ agentPageId: 'a1', role: 'GUEST', customRoleId: null, includeContext: true }]],
    [mcpTokenDrives, [{ tokenId: 'k1', role: null, customRoleId: null }, { tokenId: 'k2', role: 'OWNER', customRoleId: null }]],
    [pages, [{ id: 'p1', isPrivate: true }, { id: 'p2', isPrivate: null }]],
  ]);

  it('SEAT-9 (partial) [D-OW-33] reads every part by default (no page privacy unless asked), mapping roles, pending rows and inherit tokens', async () => {
    const { executor, reads } = fakeExecutor(full);
    const s = await snapshotDriveAccess(executor as never, 'd1');
    expect(s.drive).toEqual({ leadId: 'lead', orgId: 'org', orgVisibility: 'RESTRICTED' });
    expect(s.roles.r1).toEqual({ grant: { permissions: {}, driveWidePermissions: null }, isDefault: true });
    expect(s.members).toEqual({ u1: { role: 'ADMIN', customRoleId: null, accepted: true }, u2: { role: 'MEMBER', customRoleId: 'r1', accepted: false } });
    expect(s.grants['p1:u1']).toEqual({ canView: true, canEdit: false, canShare: false, canDelete: false });
    expect(s.agents.a1).toEqual({ role: 'GUEST', customRoleId: null, includeContext: true });
    expect(s.tokens).toEqual({ k1: { role: null, customRoleId: null }, k2: { role: 'OWNER', customRoleId: null } });
    expect(s.pagePrivacy).toEqual({});
    expect(reads.every((r) => !r.locked)).toBe(true);
  });

  it('SEAT-9 (partial) [D-OW-33] a scope reads only what it names; `lock` reads the scoped rows FOR UPDATE', async () => {
    const { executor, reads } = fakeExecutor(full);
    const s = await snapshotDriveAccess(executor as never, 'd1', { members: false, grants: false, agents: false, tokens: false, pages: ['p1', 'p2'] }, { lock: true });
    expect(s.members).toEqual({});
    expect(s.grants).toEqual({});
    expect(s.agents).toEqual({});
    expect(s.tokens).toEqual({});
    expect(s.pagePrivacy).toEqual({ p1: true, p2: false });
    expect(reads.filter((r) => r.table === pages)).toEqual([{ table: pages, locked: true }]);

    const users = fakeExecutor(full);
    await snapshotDriveAccess(users.executor as never, 'd1', { users: ['u1'] }, { lock: true });
    expect(users.reads.filter((r) => r.table === driveMembers || r.table === pagePermissions || r.table === driveAgentMembers || r.table === mcpTokenDrives).every((r) => r.locked)).toBe(true);

    const nobody = fakeExecutor(full);
    const empty = await snapshotDriveAccess(nobody.executor as never, 'd1', { users: [] });
    expect(empty.members).toEqual({});
    expect(empty.grants).toEqual({});
    expect(nobody.reads.some((r) => r.table === driveMembers || r.table === pagePermissions)).toBe(false);

    const gone = fakeExecutor(new Map());
    expect((await snapshotDriveAccess(gone.executor as never, 'd1')).drive).toBeNull();
  });
});

describe('guardDriveAccess', () => {
  it('SEAT-9 (partial) [D-OW-33] review P2-1: takes the per-drive advisory lock (the key guardOpenRoleFloor uses) before a locked baseline', async () => {
    const { executor, reads, executed } = fakeExecutor(new Map<unknown, Array<Record<string, unknown>>>([[drives, drive()]]));
    expect(await guardDriveAccess(executor as never, 'd1', {}, async () => 'written')).toBe('written');
    expect(executed).toHaveLength(1);
    expect(JSON.stringify(executed[0])).toContain(driveAccessLockKey('d1'));
    expect(driveAccessLockKey('d1')).toBe('drive-roles:d1');
    // The first snapshot (before the write) is locked; the second is not.
    const memberReads = reads.filter((r) => r.table === driveMembers);
    expect(memberReads.map((r) => r.locked)).toEqual([true, false]);
  });

  it('SEAT-9 (partial) [D-OW-33] refuses (OrgLapsedError) when the write widened access and the org is lapsed; asks no lapse when nothing widened', async () => {
    const rows: Rows = new Map<unknown, Array<Record<string, unknown>>>([[drives, drive()], [driveMembers, []]]);
    const { executor } = fakeExecutor(rows);
    checkOrgMayLoosen.mockImplementation(async (_e: unknown, _o: string, loosens: boolean) => (loosens ? LAPSED : null));
    await expect(guardDriveAccess(executor as never, 'd1', {}, async () => {
      rows.set(driveMembers, [{ userId: 'u9', role: 'MEMBER', customRoleId: null, acceptedAt: new Date() }]);
    })).rejects.toBeInstanceOf(OrgLapsedError);

    const still = fakeExecutor(new Map<unknown, Array<Record<string, unknown>>>([[drives, drive()]]));
    expect(await guardDriveAccess(still.executor as never, 'd1', {}, async () => 1)).toBe(1);
    expect(checkOrgMayLoosen).toHaveBeenLastCalledWith(still.executor, 'org', false);
  });

  it('SEAT-9 (partial) [D-OW-33] judges BOTH orgs when the write moves the drive, and none for a personal drive', async () => {
    const rows: Rows = new Map<unknown, Array<Record<string, unknown>>>([[drives, drive({ orgId: 'org-a' })]]);
    const { executor } = fakeExecutor(rows);
    await guardDriveAccess(executor as never, 'd1', {}, async () => { rows.set(drives, drive({ orgId: 'org-b' })); });
    expect(checkOrgMayLoosen.mock.calls.map((c) => c[1]).sort()).toEqual(['org-a', 'org-b']);

    checkOrgMayLoosen.mockClear();
    const personal = fakeExecutor(new Map<unknown, Array<Record<string, unknown>>>([[drives, drive({ orgId: null })]]));
    await guardDriveAccess(personal.executor as never, 'd1', {}, async () => undefined);
    expect(checkOrgMayLoosen).not.toHaveBeenCalled();
  });

  it('OrgLapsedError carries the lapse refusal and isOrgLapsedError recognises only it', () => {
    const error = new OrgLapsedError();
    expect(error).toMatchObject({ code: 'org_lapsed', status: 402, message: 'lapsed copy', name: 'OrgLapsedError' });
    expect(isOrgLapsedError(error)).toBe(true);
    expect(isOrgLapsedError(new Error('lapsed copy'))).toBe(false);
  });
});
