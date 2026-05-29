import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@pagespace/db/db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), delete: vi.fn(), update: vi.fn() },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((_a: unknown, _b: unknown) => 'eq'),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  ne: vi.fn((_a: unknown, _b: unknown) => 'ne'),
  isNotNull: vi.fn((_a: unknown) => 'isNotNull'),
  inArray: vi.fn((_a: unknown, _b: unknown) => 'inArray'),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', type: 'type', driveId: 'driveId' },
  drives: { id: 'id', name: 'name', slug: 'slug', ownerId: 'ownerId' },
}));
vi.mock('@pagespace/db/schema/members', () => ({
  driveAgentMembers: { id: 'id', driveId: 'driveId', agentPageId: 'agentPageId', role: 'role', customRoleId: 'customRoleId', addedBy: 'addedBy' },
  driveMembers: { driveId: 'driveId', userId: 'userId', role: 'role', customRoleId: 'customRoleId', acceptedAt: 'acceptedAt' },
}));
vi.mock('../../permissions/permissions', () => ({
  canUserViewPage: vi.fn(),
  canUserEditPage: vi.fn(),
  getUserDriveAccess: vi.fn(),
  isDriveOwnerOrAdmin: vi.fn(),
}));
vi.mock('../../permissions/membership-queries', () => ({
  customRoleBelongsToDrive: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import {
  addAgentToDrive,
  revokeAgentMembershipsGrantedBy,
  recapAgentMembershipsGrantedBy,
} from '../drive-agent-service';
import { db } from '@pagespace/db/db';
import { eq, ne } from '@pagespace/db/operators';
import { driveAgentMembers } from '@pagespace/db/schema/members';
import { pages } from '@pagespace/db/schema/core';
import { canUserEditPage, getUserDriveAccess } from '../../permissions/permissions';
import { customRoleBelongsToDrive } from '../../permissions/membership-queries';

const USER = 'user_aaaaaaaaaaaaaaaaaaaaaa';
const AGENT = 'agent_bbbbbbbbbbbbbbbbbbbbbb';
const DRIVE = 'drive_cccccccccccccccccccccc';

function stubSelect(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as unknown as ReturnType<typeof db.select>;
}

// Captures the row passed to insert(...).values(...) and resolves returning().
function stubInsert(captured: Record<string, unknown>[], opts: { throwCode?: string } = {}) {
  vi.mocked(db.insert).mockReturnValue({
    values: vi.fn((v: Record<string, unknown>) => {
      captured.push(v);
      return {
        returning: vi.fn(() =>
          opts.throwCode
            ? Promise.reject(Object.assign(new Error('dup'), { code: opts.throwCode }))
            : Promise.resolve([{ id: 'member_1', ...v }]),
        ),
      };
    }),
  } as unknown as ReturnType<typeof db.insert>);
}

const AI_CHAT_PAGE = [{ id: AGENT, type: 'AI_CHAT' }];

describe('addAgentToDrive', () => {
  beforeEach(() => vi.clearAllMocks());

  it('404 when the agent page does not exist', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubSelect([]));
    const res = await addAgentToDrive({ actingUserId: USER, agentPageId: AGENT, driveId: DRIVE });
    expect(res).toMatchObject({ ok: false, status: 404 });
  });

  it('400 when the page is not an AI_CHAT page', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubSelect([{ id: AGENT, type: 'FOLDER' }]));
    const res = await addAgentToDrive({ actingUserId: USER, agentPageId: AGENT, driveId: DRIVE });
    expect(res).toMatchObject({ ok: false, status: 400 });
  });

  // Regression: view-only access to a shared agent must NOT be enough to bind it
  // to a drive. Running the agent is gated by edit access, so a view-only granter
  // could otherwise leak a private drive to everyone who can run the agent.
  it('403 when the user can only view (not edit) the agent', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubSelect(AI_CHAT_PAGE));
    vi.mocked(canUserEditPage).mockResolvedValue(false);
    const res = await addAgentToDrive({ actingUserId: USER, agentPageId: AGENT, driveId: DRIVE });
    expect(res).toMatchObject({ ok: false, status: 403 });
    // Drive access must never be consulted once the agent gate fails.
    expect(getUserDriveAccess).not.toHaveBeenCalled();
  });

  it('403 when the user has no access to the target drive', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect(AI_CHAT_PAGE))                 // agent lookup
      .mockReturnValueOnce(stubSelect([{ ownerId: 'someone_else' }])) // drive lookup
      .mockReturnValueOnce(stubSelect([]));                           // no membership
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(getUserDriveAccess).mockResolvedValue(false);
    const res = await addAgentToDrive({ actingUserId: USER, agentPageId: AGENT, driveId: DRIVE });
    expect(res).toMatchObject({ ok: false, status: 403 });
  });

  it('inherits ADMIN when the granter owns the drive', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect(AI_CHAT_PAGE))            // agent lookup
      .mockReturnValueOnce(stubSelect([{ ownerId: USER }]));   // drive lookup → owner
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    const captured: Record<string, unknown>[] = [];
    stubInsert(captured);

    const res = await addAgentToDrive({ actingUserId: USER, agentPageId: AGENT, driveId: DRIVE });
    expect(res.ok).toBe(true);
    expect(captured[0]).toMatchObject({ role: 'ADMIN', driveId: DRIVE, agentPageId: AGENT, addedBy: USER });
  });

  it('caps a viewer (page-level access only) at MEMBER', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect(AI_CHAT_PAGE))                 // agent lookup
      .mockReturnValueOnce(stubSelect([{ ownerId: 'someone_else' }])) // drive lookup
      .mockReturnValueOnce(stubSelect([]));                           // no drive membership
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(getUserDriveAccess).mockResolvedValue(true); // page-level access
    const captured: Record<string, unknown>[] = [];
    stubInsert(captured);

    const res = await addAgentToDrive({ actingUserId: USER, agentPageId: AGENT, driveId: DRIVE });
    expect(res.ok).toBe(true);
    expect(captured[0]).toMatchObject({ role: 'MEMBER' });
  });

  it('rejects a request to grant ADMIN when the granter is only a MEMBER', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect(AI_CHAT_PAGE))                            // agent lookup
      .mockReturnValueOnce(stubSelect([{ ownerId: 'someone_else' }]))          // drive lookup
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: null }])); // member
    vi.mocked(canUserEditPage).mockResolvedValue(true);

    const res = await addAgentToDrive({ actingUserId: USER, agentPageId: AGENT, driveId: DRIVE, requestedRole: 'ADMIN' });
    expect(res).toMatchObject({ ok: false, status: 403 });
  });

  it('rejects assigning a custom role for non-admin granters', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect(AI_CHAT_PAGE))
      .mockReturnValueOnce(stubSelect([{ ownerId: 'someone_else' }]))
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: null }]));
    vi.mocked(canUserEditPage).mockResolvedValue(true);

    const res = await addAgentToDrive({
      actingUserId: USER,
      agentPageId: AGENT,
      driveId: DRIVE,
      requestedCustomRoleId: 'role_x',
    });
    expect(res).toMatchObject({ ok: false, status: 403 });
    expect(customRoleBelongsToDrive).not.toHaveBeenCalled();
  });

  it('returns 409 on a duplicate membership (idempotent)', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect(AI_CHAT_PAGE))
      .mockReturnValueOnce(stubSelect([{ ownerId: USER }]));
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    stubInsert([], { throwCode: '23505' });

    const res = await addAgentToDrive({ actingUserId: USER, agentPageId: AGENT, driveId: DRIVE });
    expect(res).toMatchObject({ ok: false, status: 409 });
  });
});

// select(...).from(...).innerJoin(...).where(...) resolving to rows (no .limit).
function stubJoinSelect(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as unknown as ReturnType<typeof db.select>;
}

// delete(...).where(...) → resolves; returns the captured where() mock.
function stubDelete() {
  const where = vi.fn().mockResolvedValue(undefined);
  vi.mocked(db.delete).mockReturnValue({ where } as unknown as ReturnType<typeof db.delete>);
  return where;
}

// update(...).set(values).where(...) → resolves; captures the set() value.
function stubUpdate(captured: Record<string, unknown>[]) {
  const where = vi.fn().mockResolvedValue(undefined);
  vi.mocked(db.update).mockReturnValue({
    set: vi.fn((v: Record<string, unknown>) => {
      captured.push(v);
      return { where };
    }),
  } as unknown as ReturnType<typeof db.update>);
  return where;
}

describe('revokeAgentMembershipsGrantedBy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletes the non-home memberships the user granted and returns their agent ids', async () => {
    vi.mocked(db.select).mockReturnValueOnce(
      stubJoinSelect([
        { id: 'm1', agentPageId: 'a1' },
        { id: 'm2', agentPageId: 'a2' },
      ]),
    );
    const where = stubDelete();

    const result = await revokeAgentMembershipsGrantedBy(db, DRIVE, USER);

    expect(result).toEqual(['a1', 'a2']);
    expect(db.delete).toHaveBeenCalledWith(driveAgentMembers);
    expect(where).toHaveBeenCalledTimes(1);
    // Scoped to the granting user and excludes the agent's home drive.
    expect(eq).toHaveBeenCalledWith(driveAgentMembers.addedBy, USER);
    expect(eq).toHaveBeenCalledWith(driveAgentMembers.driveId, DRIVE);
    expect(ne).toHaveBeenCalledWith(pages.driveId, DRIVE);
  });

  it('is a no-op (no delete) when the user granted no agent memberships here', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubJoinSelect([]));
    stubDelete();

    const result = await revokeAgentMembershipsGrantedBy(db, DRIVE, USER);

    expect(result).toEqual([]);
    expect(db.delete).not.toHaveBeenCalled();
  });
});

describe('recapAgentMembershipsGrantedBy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is a no-op when the user can still grant ADMIN (drive owner)', async () => {
    // resolveGranterAccess: drive lookup → owner ⇒ maxRole ADMIN.
    vi.mocked(db.select).mockReturnValueOnce(stubSelect([{ ownerId: USER }]));

    const result = await recapAgentMembershipsGrantedBy(DRIVE, USER);

    expect(result).toEqual([]);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('downgrades ADMIN agents to the granter ceiling (plain MEMBER) and never widens', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ ownerId: 'someone_else' }]))             // drive lookup
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: null }]))  // membership → MEMBER, no custom role
      .mockReturnValueOnce(stubJoinSelect([{ id: 'm1', agentPageId: 'a1' }]));    // ADMIN agent rows
    const captured: Record<string, unknown>[] = [];
    stubUpdate(captured);

    const result = await recapAgentMembershipsGrantedBy(DRIVE, USER);

    expect(result).toEqual(['a1']);
    expect(captured[0]).toEqual({ role: 'MEMBER', customRoleId: null });
    // Only ADMIN memberships are selected for reduction — custom-role memberships
    // are preserved so recap can never broaden an agent's page reach.
    expect(eq).toHaveBeenCalledWith(driveAgentMembers.role, 'ADMIN');
  });

  it('caps ADMIN agents to the granter\'s own custom role when the granter has one', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ ownerId: 'someone_else' }]))                  // drive lookup
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: 'role_b' }]))   // membership → MEMBER + custom role
      .mockReturnValueOnce(stubJoinSelect([{ id: 'm1', agentPageId: 'a1' }]));         // ADMIN agent rows
    const captured: Record<string, unknown>[] = [];
    stubUpdate(captured);

    const result = await recapAgentMembershipsGrantedBy(DRIVE, USER);

    expect(result).toEqual(['a1']);
    expect(captured[0]).toEqual({ role: 'MEMBER', customRoleId: 'role_b' });
  });

  it('is a no-op when a downgraded granter has no ADMIN agents (custom-role agents preserved)', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ ownerId: 'someone_else' }]))             // drive lookup
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: null }]))  // membership → MEMBER
      .mockReturnValueOnce(stubJoinSelect([]));                                   // no ADMIN agents to reduce
    stubUpdate([]);

    const result = await recapAgentMembershipsGrantedBy(DRIVE, USER);

    expect(result).toEqual([]);
    expect(db.update).not.toHaveBeenCalled();
  });
});
