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
  drives: { id: 'id', name: 'name', slug: 'slug', ownerId: 'ownerId', drivePrompt: 'drivePrompt' },
}));
vi.mock('@pagespace/db/schema/members', () => ({
  driveAgentMembers: { id: 'id', driveId: 'driveId', agentPageId: 'agentPageId', role: 'role', customRoleId: 'customRoleId', includeContext: 'includeContext', addedBy: 'addedBy' },
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
  fetchCustomRolePermissions: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import {
  addAgentToDrive,
  revokeAgentMembershipsGrantedBy,
  recapAgentMembershipsGrantedBy,
  listAgentDrives,
  getAgentContextDrives,
  setAgentDriveIncludeContext,
} from '../drive-agent-service';
import { db } from '@pagespace/db/db';
import { eq, ne } from '@pagespace/db/operators';
import { driveAgentMembers } from '@pagespace/db/schema/members';
import { pages } from '@pagespace/db/schema/core';
import { canUserEditPage, getUserDriveAccess, isDriveOwnerOrAdmin } from '../../permissions/permissions';
import { customRoleBelongsToDrive, fetchCustomRolePermissions } from '../../permissions/membership-queries';

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

  it('403 when the target drive is a Home drive — even for its owner (no agent memberships in Home)', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect(AI_CHAT_PAGE))                          // agent lookup
      .mockReturnValueOnce(stubSelect([{ ownerId: USER, kind: 'HOME' }]));    // drive lookup → owner of Home
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    const captured: Record<string, unknown>[] = [];
    stubInsert(captured);

    const res = await addAgentToDrive({ actingUserId: USER, agentPageId: AGENT, driveId: DRIVE });

    expect(res).toMatchObject({
      ok: false,
      status: 403,
      error: 'Your Home drive is private and cannot be shared.',
    });
    expect(captured).toHaveLength(0);
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

  it('defaults includeContext to false when not provided', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect(AI_CHAT_PAGE))
      .mockReturnValueOnce(stubSelect([{ ownerId: USER }]));
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    const captured: Record<string, unknown>[] = [];
    stubInsert(captured);

    const res = await addAgentToDrive({ actingUserId: USER, agentPageId: AGENT, driveId: DRIVE });
    expect(res.ok).toBe(true);
    expect(captured[0]).toMatchObject({ includeContext: false });
  });

  it('persists includeContext=true when explicitly requested', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect(AI_CHAT_PAGE))
      .mockReturnValueOnce(stubSelect([{ ownerId: USER }]));
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    const captured: Record<string, unknown>[] = [];
    stubInsert(captured);

    const res = await addAgentToDrive({ actingUserId: USER, agentPageId: AGENT, driveId: DRIVE, includeContext: true });
    expect(res.ok).toBe(true);
    expect(captured[0]).toMatchObject({ includeContext: true });
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

  it('reduces ADMIN agents to plain MEMBER when the granter is now a plain MEMBER', async () => {
    // A plain-MEMBER agent now sees only non-private pages — the same set the
    // granting member sees — so capping ADMIN → plain MEMBER no longer over-grants.
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ ownerId: 'someone_else' }]))             // drive lookup
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: null }]))  // membership → plain MEMBER
      .mockReturnValueOnce(stubJoinSelect([{ id: 'm1', agentPageId: 'a1', role: 'ADMIN', customRoleId: null }]));
    const captured: Record<string, unknown>[] = [];
    stubUpdate(captured);
    stubDelete();

    const result = await recapAgentMembershipsGrantedBy(DRIVE, USER);

    expect(result).toEqual(['a1']);
    expect(captured[0]).toEqual({ role: 'MEMBER', customRoleId: null });
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('caps ADMIN agents to the granter\'s own custom role when the granter has one', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ ownerId: 'someone_else' }]))                  // drive lookup
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: 'role_b' }]))   // membership → MEMBER + custom role
      .mockReturnValueOnce(stubJoinSelect([{ id: 'm1', agentPageId: 'a1', role: 'ADMIN', customRoleId: null }]));
    const captured: Record<string, unknown>[] = [];
    stubUpdate(captured);
    stubDelete();

    const result = await recapAgentMembershipsGrantedBy(DRIVE, USER);

    expect(result).toEqual(['a1']);
    expect(captured[0]).toEqual({ role: 'MEMBER', customRoleId: 'role_b' });
  });

  it('REVOKES a custom-role agent whose scope differs from the granter cap', async () => {
    // A custom-role matrix is incomparable to plain MEMBER (it may scope to fewer
    // pages, or grant private/edit access the cap doesn't), so rewriting it could
    // widen the agent. Revoke rather than guess.
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ ownerId: 'someone_else' }]))                          // drive lookup
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: null }]))               // granter now plain MEMBER
      .mockReturnValueOnce(stubJoinSelect([{ id: 'm2', agentPageId: 'a2', role: 'MEMBER', customRoleId: 'role_a' }]));
    stubUpdate([]);
    const where = stubDelete();

    const result = await recapAgentMembershipsGrantedBy(DRIVE, USER);

    expect(result).toEqual(['a2']);
    expect(db.delete).toHaveBeenCalledWith(driveAgentMembers);
    expect(where).toHaveBeenCalledTimes(1);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('REVOKES a plain-MEMBER agent when the granter cap is a (narrower) custom role', async () => {
    // agent {MEMBER,null} sees all non-private pages; the granter's custom-role cap
    // may be narrower (or otherwise incomparable), so rewriting null→role could
    // widen or skew the agent. Revoke instead.
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ ownerId: 'someone_else' }]))                              // drive lookup
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: 'role_b' }]))               // granter custom role
      .mockReturnValueOnce(stubJoinSelect([{ id: 'm5', agentPageId: 'a5', role: 'MEMBER', customRoleId: null }]));
    stubUpdate([]);
    const where = stubDelete();

    const result = await recapAgentMembershipsGrantedBy(DRIVE, USER);

    expect(result).toEqual(['a5']);
    expect(db.delete).toHaveBeenCalledWith(driveAgentMembers);
    expect(where).toHaveBeenCalledTimes(1);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('LEAVES a custom-role agent whose role is a subset of the granter\'s new (broader) custom role', async () => {
    // The granter moved laterally to a broader custom role (role_b ⊇ role_a). The
    // agent still sits under the granter, so it must NOT be revoked or rewritten.
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ ownerId: 'someone_else' }]))                          // drive lookup
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: 'role_b' }]))            // granter now role_b
      .mockReturnValueOnce(stubJoinSelect([{ id: 'm6', agentPageId: 'a6', role: 'MEMBER', customRoleId: 'role_a' }]));
    vi.mocked(fetchCustomRolePermissions)
      .mockResolvedValueOnce({ permissions: { pageX: { canView: true, canEdit: false, canShare: false } }, driveWidePermissions: null })     // role_a (agent)
      .mockResolvedValueOnce({                                                                                                               // role_b (cap) ⊇ role_a
        permissions: { pageX: { canView: true, canEdit: true, canShare: false }, pageY: { canView: true, canEdit: false, canShare: false } },
        driveWidePermissions: null,
      });
    stubUpdate([]);
    stubDelete();

    const result = await recapAgentMembershipsGrantedBy(DRIVE, USER);

    expect(result).toEqual([]);
    expect(db.update).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('REVOKES a custom-role agent whose role is NOT a subset of the granter\'s new custom role', async () => {
    // The granter moved to role_c, which drops pages role_a granted. The agent now
    // exceeds the granter, and the scopes are not representable as one another ⇒ revoke.
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ ownerId: 'someone_else' }]))                          // drive lookup
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: 'role_c' }]))            // granter now role_c
      .mockReturnValueOnce(stubJoinSelect([{ id: 'm7', agentPageId: 'a7', role: 'MEMBER', customRoleId: 'role_a' }]));
    vi.mocked(fetchCustomRolePermissions)
      .mockResolvedValueOnce({ permissions: { pageX: { canView: true, canEdit: false, canShare: false } }, driveWidePermissions: null })     // role_a (agent)
      .mockResolvedValueOnce({ permissions: { pageZ: { canView: true, canEdit: false, canShare: false } }, driveWidePermissions: null });    // role_c (cap), no pageX
    stubUpdate([]);
    const where = stubDelete();

    const result = await recapAgentMembershipsGrantedBy(DRIVE, USER);

    expect(result).toEqual(['a7']);
    expect(db.delete).toHaveBeenCalledWith(driveAgentMembers);
    expect(where).toHaveBeenCalledTimes(1);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('leaves a custom-role agent untouched when it already matches the granter ceiling', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ ownerId: 'someone_else' }]))                              // drive lookup
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: 'role_same' }]))            // granter custom role
      .mockReturnValueOnce(stubJoinSelect([{ id: 'm3', agentPageId: 'a3', role: 'MEMBER', customRoleId: 'role_same' }]));
    stubUpdate([]);
    stubDelete();

    const result = await recapAgentMembershipsGrantedBy(DRIVE, USER);

    expect(result).toEqual([]);
    expect(db.update).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('leaves an existing plain-MEMBER agent untouched under a plain-MEMBER granter', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ ownerId: 'someone_else' }]))                            // drive lookup
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: null }]))                 // granter plain MEMBER
      .mockReturnValueOnce(stubJoinSelect([{ id: 'm4', agentPageId: 'a4', role: 'MEMBER', customRoleId: null }]));
    stubUpdate([]);
    stubDelete();

    const result = await recapAgentMembershipsGrantedBy(DRIVE, USER);

    // Already exactly what a plain-member granter could create — not touched.
    expect(result).toEqual([]);
    expect(db.update).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('REVOKES when the agent role has non-null driveWidePermissions (fail-closed)', async () => {
    // driveWidePermissions spans the entire drive — we cannot verify it fits within
    // any per-page cap, so we revoke unconditionally rather than risk widening access.
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ ownerId: 'someone_else' }]))
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: 'role_b' }]))
      .mockReturnValueOnce(stubJoinSelect([{ id: 'm8', agentPageId: 'a8', role: 'MEMBER', customRoleId: 'role_a' }]));
    vi.mocked(fetchCustomRolePermissions)
      .mockResolvedValueOnce({ permissions: {}, driveWidePermissions: { canView: true, canEdit: false, canShare: false } })   // role_a (agent) — has driveWide
      .mockResolvedValueOnce({ permissions: { pageX: { canView: true, canEdit: true, canShare: false } }, driveWidePermissions: null });   // role_b (cap)
    stubUpdate([]);
    const where = stubDelete();

    const result = await recapAgentMembershipsGrantedBy(DRIVE, USER);

    expect(result).toEqual(['a8']);
    expect(db.delete).toHaveBeenCalledWith(driveAgentMembers);
    expect(where).toHaveBeenCalledTimes(1);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('REVOKES when the granter cap role has non-null driveWidePermissions (fail-closed)', async () => {
    // The cap has a drive-wide span — the subset check cannot be done safely.
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ ownerId: 'someone_else' }]))
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: 'role_b' }]))
      .mockReturnValueOnce(stubJoinSelect([{ id: 'm9', agentPageId: 'a9', role: 'MEMBER', customRoleId: 'role_a' }]));
    vi.mocked(fetchCustomRolePermissions)
      .mockResolvedValueOnce({ permissions: { pageX: { canView: true, canEdit: false, canShare: false } }, driveWidePermissions: null })   // role_a (agent)
      .mockResolvedValueOnce({ permissions: {}, driveWidePermissions: { canView: true, canEdit: true, canShare: false } });                 // role_b (cap) — has driveWide
    stubUpdate([]);
    const where = stubDelete();

    const result = await recapAgentMembershipsGrantedBy(DRIVE, USER);

    expect(result).toEqual(['a9']);
    expect(db.delete).toHaveBeenCalledWith(driveAgentMembers);
    expect(where).toHaveBeenCalledTimes(1);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('REVOKES when both agent and cap roles have non-null driveWidePermissions (fail-closed)', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ ownerId: 'someone_else' }]))
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: 'role_b' }]))
      .mockReturnValueOnce(stubJoinSelect([{ id: 'm10', agentPageId: 'a10', role: 'MEMBER', customRoleId: 'role_a' }]));
    vi.mocked(fetchCustomRolePermissions)
      .mockResolvedValueOnce({ permissions: {}, driveWidePermissions: { canView: true, canEdit: false, canShare: false } })   // role_a — has driveWide
      .mockResolvedValueOnce({ permissions: {}, driveWidePermissions: { canView: true, canEdit: true, canShare: true } });    // role_b — also has driveWide
    stubUpdate([]);
    const where = stubDelete();

    const result = await recapAgentMembershipsGrantedBy(DRIVE, USER);

    expect(result).toEqual(['a10']);
    expect(db.delete).toHaveBeenCalledWith(driveAgentMembers);
    expect(where).toHaveBeenCalledTimes(1);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('is a no-op when a downgraded granter granted no agents', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ ownerId: 'someone_else' }]))             // drive lookup
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: null }]))  // membership → MEMBER
      .mockReturnValueOnce(stubJoinSelect([]));                                   // no agents granted
    stubUpdate([]);
    stubDelete();

    const result = await recapAgentMembershipsGrantedBy(DRIVE, USER);

    expect(result).toEqual([]);
    expect(db.update).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });
});

describe('listAgentDrives', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns includeContext for an existing membership row (including the home drive)', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ driveId: DRIVE }])) // agent lookup: home drive is DRIVE
      .mockReturnValueOnce(stubJoinSelect([
        { driveId: DRIVE, role: 'ADMIN', customRoleId: null, includeContext: true, driveName: 'Home', driveSlug: 'home' },
      ]));

    const result = await listAgentDrives(AGENT);

    expect(result).toEqual([
      { driveId: DRIVE, driveName: 'Home', driveSlug: 'home', role: 'ADMIN', customRoleId: null, isHome: true, includeContext: true },
    ]);
  });

  it('synthesizes a home-drive entry with includeContext=false when no membership row exists for it', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ driveId: DRIVE }])) // agent lookup
      .mockReturnValueOnce(stubJoinSelect([])) // no membership rows
      .mockReturnValueOnce(stubSelect([{ id: DRIVE, name: 'Home', slug: 'home' }])); // home drive lookup

    const result = await listAgentDrives(AGENT);

    expect(result).toEqual([
      { driveId: DRIVE, driveName: 'Home', driveSlug: 'home', role: 'ADMIN', customRoleId: null, isHome: true, includeContext: false },
    ]);
  });
});

describe('getAgentContextDrives', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns [] when the agent page does not exist', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubSelect([]));
    const result = await getAgentContextDrives(AGENT);
    expect(result).toEqual([]);
  });

  it('returns non-home, includeContext=true drives with a non-empty drivePrompt', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ driveId: 'home_drive' }])) // agent lookup
      .mockReturnValueOnce(stubJoinSelect([
        { driveId: DRIVE, driveName: 'Marketing', drivePrompt: 'Be casual.' },
      ]));

    const result = await getAgentContextDrives(AGENT);

    expect(result).toEqual([{ driveId: DRIVE, driveName: 'Marketing', drivePrompt: 'Be casual.' }]);
    expect(eq).toHaveBeenCalledWith(driveAgentMembers.agentPageId, AGENT);
    expect(eq).toHaveBeenCalledWith(driveAgentMembers.includeContext, true);
    expect(ne).toHaveBeenCalledWith(driveAgentMembers.driveId, 'home_drive');
  });

  it('drops rows with an empty or whitespace-only drivePrompt', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ driveId: 'home_drive' }]))
      .mockReturnValueOnce(stubJoinSelect([
        { driveId: DRIVE, driveName: 'Marketing', drivePrompt: '   ' },
        { driveId: 'drive2', driveName: 'Empty', drivePrompt: null },
      ]));

    const result = await getAgentContextDrives(AGENT);

    expect(result).toEqual([]);
  });
});

describe('setAgentDriveIncludeContext', () => {
  beforeEach(() => vi.clearAllMocks());

  it('404 when the agent page does not exist', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubSelect([]));
    const res = await setAgentDriveIncludeContext({ actingUserId: USER, agentPageId: AGENT, driveId: DRIVE, includeContext: true });
    expect(res).toMatchObject({ ok: false, status: 404 });
  });

  it("400 when the target drive is the agent's home drive", async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubSelect([{ id: AGENT, driveId: DRIVE }]));
    const res = await setAgentDriveIncludeContext({ actingUserId: USER, agentPageId: AGENT, driveId: DRIVE, includeContext: true });
    expect(res).toMatchObject({ ok: false, status: 400 });
  });

  it('403 when the user cannot manage the agent nor the drive', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubSelect([{ id: AGENT, driveId: 'other_drive' }]));
    vi.mocked(canUserEditPage).mockResolvedValue(false);
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(false);
    const res = await setAgentDriveIncludeContext({ actingUserId: USER, agentPageId: AGENT, driveId: DRIVE, includeContext: true });
    expect(res).toMatchObject({ ok: false, status: 403 });
  });

  it('updates includeContext and returns the updated member', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubSelect([{ id: AGENT, driveId: 'other_drive' }]));
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    const captured: Record<string, unknown>[] = [];
    const where = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'member_1', includeContext: true }]) });
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn((v: Record<string, unknown>) => {
        captured.push(v);
        return { where };
      }),
    } as unknown as ReturnType<typeof db.update>);

    const res = await setAgentDriveIncludeContext({ actingUserId: USER, agentPageId: AGENT, driveId: DRIVE, includeContext: true });

    expect(res).toMatchObject({ ok: true, member: { id: 'member_1', includeContext: true } });
    expect(captured[0]).toEqual({ includeContext: true });
  });

  it('404 when the membership row does not exist', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubSelect([{ id: AGENT, driveId: 'other_drive' }]));
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    const where = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) });
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn(() => ({ where })),
    } as unknown as ReturnType<typeof db.update>);

    const res = await setAgentDriveIncludeContext({ actingUserId: USER, agentPageId: AGENT, driveId: DRIVE, includeContext: true });
    expect(res).toMatchObject({ ok: false, status: 404 });
  });
});
