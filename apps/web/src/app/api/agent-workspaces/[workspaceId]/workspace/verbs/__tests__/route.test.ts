// @vitest-environment node
/**
 * POST `/api/agent-workspaces/[workspaceId]/workspace/verbs` — what matters here
 * is the not-found/denied family policy (a uniform 404 whether the session is
 * unknown or someone else's), that a malformed body/verb never reaches the
 * engine, the stale-baseRev 409 carrying truth to rebase against, and that
 * only an APPLIED verb is audited.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuthenticateRequest,
  mockAuditRequest,
  mockCheckSessionAccess,
  mockApplyWorkspaceLayoutVerb,
  mockAuthorizeVerbScopes,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockAuditRequest: vi.fn(),
  mockCheckSessionAccess: vi.fn(),
  mockApplyWorkspaceLayoutVerb: vi.fn(),
  mockAuthorizeVerbScopes: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequest(...args),
  isAuthError: (result: unknown) => result != null && typeof result === 'object' && 'error' in result,
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: (...args: unknown[]) => mockAuditRequest(...args),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { error: vi.fn(), warn: vi.fn() } },
}));
vi.mock('@/lib/agent-workspaces/agent-sessions-runtime', () => ({
  checkSessionAccess: (...args: unknown[]) => mockCheckSessionAccess(...args),
}));
vi.mock('@/lib/agent-workspaces/workspace-layout-runtime', () => ({
  applyWorkspaceLayoutVerb: (...args: unknown[]) => mockApplyWorkspaceLayoutVerb(...args),
}));
vi.mock('@/lib/agent-workspaces/authorize-pane-scope', () => ({
  authorizeVerbScopes: (...args: unknown[]) => mockAuthorizeVerbScopes(...args),
}));

import { POST } from '../route';

const AUTH_USER = { userId: 'user-1', role: 'admin' };
const SESSION_ID = 'ses-1';
const params = { params: Promise.resolve({ workspaceId: SESSION_ID }) };

const scope = { kind: 'chat', name: 'Conversation', targetId: 'conv-1', agentPageId: null };
const verb = { type: 'assign_pane', paneId: 'pane-1', scope };
const grid = [{ id: 'col-1', panes: [{ id: 'pane-1', scope }] }];

const post = (body?: unknown) =>
  POST(
    new Request(`http://localhost/api/agent-workspaces/${SESSION_ID}/workspace/verbs`, {
      method: 'POST',
      ...(body !== undefined
        ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
        : {}),
    }),
    params,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue(AUTH_USER);
  mockCheckSessionAccess.mockResolvedValue({ allowed: true });
  mockAuthorizeVerbScopes.mockResolvedValue(true);
  mockApplyWorkspaceLayoutVerb.mockResolvedValue({ status: 'ok', rev: 1, grid, applied: true });
});

describe('POST /api/agent-workspaces/[workspaceId]/workspace/verbs', () => {
  it('applies a well-formed verb and returns the post-write rev + grid', async () => {
    const response = await post({ opId: 'op-1', baseRev: 0, verb });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ rev: 1, grid, applied: true });
    expect(mockApplyWorkspaceLayoutVerb).toHaveBeenCalledWith({
      workspaceId: SESSION_ID,
      opId: 'op-1',
      baseRev: 0,
      verb,
      // The response grid's labels are resolved for THIS caller and nobody else.
      viewerId: AUTH_USER.userId,
    });
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'data.write',
        details: expect.objectContaining({ op: 'workspace_layout_verb', verb: 'assign_pane' }),
      }),
    );
  });

  it('answers a stale baseRev with 409 carrying the truth to rebase against — and no audit', async () => {
    mockApplyWorkspaceLayoutVerb.mockResolvedValue({ status: 'stale', rev: 7, grid });
    const response = await post({ opId: 'op-1', baseRev: 3, verb });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ rev: 7, grid });
    expect(mockAuditRequest).not.toHaveBeenCalled();
  });

  it('does not audit a no-op (replayed or content-identical) result', async () => {
    mockApplyWorkspaceLayoutVerb.mockResolvedValue({ status: 'ok', rev: 1, grid, applied: false });
    const response = await post({ opId: 'op-1', baseRev: 1, verb });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ rev: 1, grid, applied: false });
    expect(mockAuditRequest).not.toHaveBeenCalled();
  });

  it('400s a missing body', async () => {
    const response = await post(undefined);
    expect(response.status).toBe(400);
    expect(mockApplyWorkspaceLayoutVerb).not.toHaveBeenCalled();
  });

  it('400s an unknown verb type rather than trusting it', async () => {
    const response = await post({ opId: 'op-1', baseRev: 0, verb: { type: 'nuke_grid' } });
    expect(response.status).toBe(400);
    expect(mockApplyWorkspaceLayoutVerb).not.toHaveBeenCalled();
  });

  it('400s a verb missing its required ids', async () => {
    const response = await post({ opId: 'op-1', baseRev: 0, verb: { type: 'split_right', fromPaneId: 'pane-1' } });
    expect(response.status).toBe(400);
    expect(mockApplyWorkspaceLayoutVerb).not.toHaveBeenCalled();
  });

  it('400s a missing opId / non-integer baseRev', async () => {
    expect((await post({ baseRev: 0, verb })).status).toBe(400);
    expect((await post({ opId: 'op-1', baseRev: 1.5, verb })).status).toBe(400);
    expect(mockApplyWorkspaceLayoutVerb).not.toHaveBeenCalled();
  });

  it('404s an unknown session', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'session_not_found' });
    const response = await post({ opId: 'op-1', baseRev: 0, verb });
    expect(response.status).toBe(404);
    expect(mockApplyWorkspaceLayoutVerb).not.toHaveBeenCalled();
  });

  it('404s a session the requester cannot reach (SAME as not-found), but still audits the denial', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'drive_access_denied' });
    const response = await post({ opId: 'op-1', baseRev: 0, verb });
    expect(response.status).toBe(404);
    expect(mockApplyWorkspaceLayoutVerb).not.toHaveBeenCalled();
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'authz.access.denied' }),
    );
  });

  it('502s an engine failure', async () => {
    mockApplyWorkspaceLayoutVerb.mockRejectedValue(new Error('db exploded'));
    const response = await post({ opId: 'op-1', baseRev: 0, verb });
    expect(response.status).toBe(502);
  });

  it('given an auth failure, returns the auth error untouched', async () => {
    const error = new Response(null, { status: 401 });
    mockAuthenticateRequest.mockResolvedValue({ error });
    const response = await post({ opId: 'op-1', baseRev: 0, verb });
    expect(response.status).toBe(401);
    expect(mockCheckSessionAccess).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The rearrange verbs (issue #2208) — the route's own surface for them
// ---------------------------------------------------------------------------

describe('POST .../workspace/verbs — the rearrange verbs', () => {
  it.each([
    ['resize_column', { type: 'resize_column', columnId: 'col-1', widthFraction: 0.4 }],
    ['resize_pane', { type: 'resize_pane', paneId: 'pane-1', heightFraction: 0.6 }],
    ['move_pane (append)', { type: 'move_pane', paneId: 'pane-1', toColumnId: 'col-2' }],
    ['move_pane (indexed)', { type: 'move_pane', paneId: 'pane-1', toColumnId: 'col-2', toIndex: 0 }],
    ['reorder_columns', { type: 'reorder_columns', columnIds: ['col-2', 'col-1'] }],
  ])('accepts %s and hands it to the single writer verbatim', async (_label, rearrange) => {
    const response = await post({ opId: 'op-r', baseRev: 3, verb: rearrange });

    expect(response.status).toBe(200);
    expect(mockApplyWorkspaceLayoutVerb).toHaveBeenCalledWith({
      workspaceId: SESSION_ID,
      opId: 'op-r',
      baseRev: 3,
      verb: rearrange,
      viewerId: AUTH_USER.userId,
    });
  });

  it('audits an applied rearrange under its own verb name', async () => {
    await post({ opId: 'op-r', baseRev: 0, verb: { type: 'reorder_columns', columnIds: ['col-2'] } });

    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'data.write',
        resourceType: 'agent_session',
        resourceId: SESSION_ID,
        details: expect.objectContaining({ op: 'workspace_layout_verb', verb: 'reorder_columns' }),
      }),
    );
  });

  it('answers a stale baseRev on a rearrange with 409 + truth, exactly like every other verb', async () => {
    mockApplyWorkspaceLayoutVerb.mockResolvedValue({ status: 'stale', rev: 7, grid });
    const response = await post({
      opId: 'op-r',
      baseRev: 2,
      verb: { type: 'resize_column', columnId: 'col-1', widthFraction: 0.4 },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ rev: 7, grid });
    expect(mockAuditRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-finite fraction', { type: 'resize_column', columnId: 'col-1', widthFraction: Number.POSITIVE_INFINITY }],
    ['a NaN fraction', { type: 'resize_column', columnId: 'col-1', widthFraction: Number.NaN }],
    ['a string fraction', { type: 'resize_pane', paneId: 'pane-1', heightFraction: '0.5' }],
    ['a missing fraction', { type: 'resize_pane', paneId: 'pane-1' }],
    ['an empty column id', { type: 'resize_column', columnId: '', widthFraction: 0.4 }],
    ['a fractional toIndex', { type: 'move_pane', paneId: 'pane-1', toColumnId: 'col-2', toIndex: 1.5 }],
    ['a missing destination', { type: 'move_pane', paneId: 'pane-1' }],
    ['an empty reorder list', { type: 'reorder_columns', columnIds: [] }],
    ['a reorder list of non-strings', { type: 'reorder_columns', columnIds: [1, 2] }],
  ])('400s %s rather than letting it reach the engine', async (_label, rearrange) => {
    const response = await post({ opId: 'op-r', baseRev: 0, verb: rearrange });

    expect(response.status).toBe(400);
    expect(mockApplyWorkspaceLayoutVerb).not.toHaveBeenCalled();
  });

  it('refuses an oversized reorder list — the bound is on the schema, not on the reducer', async () => {
    const response = await post({
      opId: 'op-r',
      baseRev: 0,
      verb: { type: 'reorder_columns', columnIds: Array.from({ length: 65 }, (_, i) => `col-${i}`) },
    });

    expect(response.status).toBe(400);
    expect(mockApplyWorkspaceLayoutVerb).not.toHaveBeenCalled();
  });

  it('404s a rearrange aimed at a session the requester cannot reach, and never touches the grid', async () => {
    // Same anti-enumeration policy as every other verb: the new verbs open no
    // new way to learn that someone else's session exists.
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'denied' });
    const response = await post({
      opId: 'op-r',
      baseRev: 0,
      verb: { type: 'move_pane', paneId: 'pane-1', toColumnId: 'col-2' },
    });

    expect(response.status).toBe(404);
    expect(mockApplyWorkspaceLayoutVerb).not.toHaveBeenCalled();
  });
});

/**
 * Security review HIGH 1, attack B: session access is not target access. The
 * route used to hand the engine whatever `scope.targetId` the body carried,
 * so a caller with a workspace of their own could bind any conversation,
 * shell, or page id and read the joined title back out of the 200 body.
 */
describe('pane-scope authorization (attack B)', () => {
  it('REFUSES a verb whose scope target the caller has no authority over — and never reaches the engine', async () => {
    mockAuthorizeVerbScopes.mockResolvedValue(false);
    const response = await post({ opId: 'op-1', baseRev: 0, verb });
    expect(response.status).toBe(403);
    expect(mockApplyWorkspaceLayoutVerb).not.toHaveBeenCalled();
    expect(mockAuditRequest).not.toHaveBeenCalled();
    // Nothing about the target leaks back — forbidden and non-existent read alike.
    expect(await response.json()).toEqual({
      error: 'You cannot show that in this workspace.',
    });
  });

  it('asks about the scope only AFTER session access is settled', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'not_a_member' });
    await post({ opId: 'op-1', baseRev: 0, verb });
    expect(mockAuthorizeVerbScopes).not.toHaveBeenCalled();
  });

  it('passes the caller and the addressed workspace to the gate', async () => {
    await post({ opId: 'op-1', baseRev: 0, verb });
    expect(mockAuthorizeVerbScopes).toHaveBeenCalledWith({
      viewerId: AUTH_USER.userId,
      workspaceId: SESSION_ID,
      verb,
    });
  });
});
