// @vitest-environment node
/**
 * POST `/api/agent-sessions/[sessionId]/workspace/verbs` — what matters here
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
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockAuditRequest: vi.fn(),
  mockCheckSessionAccess: vi.fn(),
  mockApplyWorkspaceLayoutVerb: vi.fn(),
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
vi.mock('@/lib/agent-sessions/agent-sessions-runtime', () => ({
  checkSessionAccess: (...args: unknown[]) => mockCheckSessionAccess(...args),
}));
vi.mock('@/lib/agent-sessions/workspace-layout-runtime', () => ({
  applyWorkspaceLayoutVerb: (...args: unknown[]) => mockApplyWorkspaceLayoutVerb(...args),
}));

import { POST } from '../route';

const AUTH_USER = { userId: 'user-1', role: 'admin' };
const SESSION_ID = 'ses-1';
const params = { params: Promise.resolve({ sessionId: SESSION_ID }) };

const scope = { kind: 'chat', name: 'Conversation', targetId: 'conv-1', agentPageId: null };
const verb = { type: 'assign_pane', paneId: 'pane-1', scope };
const grid = [{ id: 'col-1', panes: [{ id: 'pane-1', scope }] }];

const post = (body?: unknown) =>
  POST(
    new Request(`http://localhost/api/agent-sessions/${SESSION_ID}/workspace/verbs`, {
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
  mockApplyWorkspaceLayoutVerb.mockResolvedValue({ status: 'ok', rev: 1, grid, applied: true });
});

describe('POST /api/agent-sessions/[sessionId]/workspace/verbs', () => {
  it('applies a well-formed verb and returns the post-write rev + grid', async () => {
    const response = await post({ opId: 'op-1', baseRev: 0, verb });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ rev: 1, grid, applied: true });
    expect(mockApplyWorkspaceLayoutVerb).toHaveBeenCalledWith({
      workspaceId: SESSION_ID,
      opId: 'op-1',
      baseRev: 0,
      verb,
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
