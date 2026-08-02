// @vitest-environment node
/**
 * GET/PUT `/api/agent-sessions/[sessionId]/workspace` — what matters here is
 * the not-found/denied family policy (SAME null-workspace answer on GET, a
 * uniform 404 on PUT) and that PUT never reaches the DB with an unvalidated
 * payload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuthenticateRequest,
  mockAuditRequest,
  mockCheckSessionAccess,
  mockGetSessionWorkspace,
  mockSaveSessionWorkspace,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockAuditRequest: vi.fn(),
  mockCheckSessionAccess: vi.fn(),
  mockGetSessionWorkspace: vi.fn(),
  mockSaveSessionWorkspace: vi.fn(),
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
vi.mock('@/lib/agent-sessions/session-workspace-runtime', () => ({
  getSessionWorkspace: (...args: unknown[]) => mockGetSessionWorkspace(...args),
  saveSessionWorkspace: (...args: unknown[]) => mockSaveSessionWorkspace(...args),
}));

import { GET, PUT } from '../route';

const AUTH_USER = { userId: 'user-1', role: 'admin' };
const SESSION_ID = 'ses-1';
const params = { params: Promise.resolve({ sessionId: SESSION_ID }) };

const workspace = {
  id: SESSION_ID,
  columns: [
    {
      id: 'col-1',
      panes: [
        {
          id: 'pane-1',
          scope: { kind: 'chat', name: 'Conversation', targetId: 'conv-1', agentPageId: null },
        },
      ],
    },
  ],
  activePaneId: 'pane-1',
  pendingPickerPaneId: null,
};

const get = () => GET(new Request(`http://localhost/api/agent-sessions/${SESSION_ID}/workspace`), params);
const put = (body?: unknown) =>
  PUT(
    new Request(`http://localhost/api/agent-sessions/${SESSION_ID}/workspace`, {
      method: 'PUT',
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
  mockGetSessionWorkspace.mockResolvedValue(null);
  mockSaveSessionWorkspace.mockResolvedValue(undefined);
});

describe('GET /api/agent-sessions/[sessionId]/workspace', () => {
  it('returns the saved workspace when one exists', async () => {
    mockGetSessionWorkspace.mockResolvedValue(workspace);
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workspace });
  });

  it('returns null for a session that has never saved a grid', async () => {
    const response = await get();
    expect(await response.json()).toEqual({ workspace: null });
  });

  it('returns null (not 404) for a session the requester cannot reach — same answer as not-found', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'drive_access_denied' });
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workspace: null });
    expect(mockGetSessionWorkspace).not.toHaveBeenCalled();
  });

  it('given an auth failure, returns the auth error untouched', async () => {
    const error = new Response(null, { status: 401 });
    mockAuthenticateRequest.mockResolvedValue({ error });
    const response = await get();
    expect(response.status).toBe(401);
    expect(mockCheckSessionAccess).not.toHaveBeenCalled();
  });
});

describe('PUT /api/agent-sessions/[sessionId]/workspace', () => {
  it('saves a well-formed workspace', async () => {
    const response = await put({ workspace });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mockSaveSessionWorkspace).toHaveBeenCalledWith({ sessionId: SESSION_ID, workspace });
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'data.write', details: expect.objectContaining({ op: 'save_workspace' }) }),
    );
  });

  it('400s a malformed workspace rather than trusting it', async () => {
    const response = await put({ workspace: { id: 'ses-1', columns: [] } }); // columns: [] fails min(1)
    expect(response.status).toBe(400);
    expect(mockSaveSessionWorkspace).not.toHaveBeenCalled();
  });

  it('400s a missing body', async () => {
    const response = await put(undefined);
    expect(response.status).toBe(400);
    expect(mockSaveSessionWorkspace).not.toHaveBeenCalled();
  });

  it("400s a workspace whose id does not match the route's sessionId", async () => {
    const response = await put({ workspace: { ...workspace, id: 'ses-OTHER' } });
    expect(response.status).toBe(400);
    expect(mockSaveSessionWorkspace).not.toHaveBeenCalled();
  });

  it('404s an unknown session', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'session_not_found' });
    const response = await put({ workspace });
    expect(response.status).toBe(404);
    expect(mockSaveSessionWorkspace).not.toHaveBeenCalled();
  });

  it('404s a session the requester cannot reach (SAME as not-found), but still audits it', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'drive_access_denied' });
    const response = await put({ workspace });
    expect(response.status).toBe(404);
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'authz.access.denied' }),
    );
  });

  it('502s a save failure', async () => {
    mockSaveSessionWorkspace.mockRejectedValue(new Error('db exploded'));
    const response = await put({ workspace });
    expect(response.status).toBe(502);
  });

  it('given an auth failure, returns the auth error untouched', async () => {
    const error = new Response(null, { status: 401 });
    mockAuthenticateRequest.mockResolvedValue({ error });
    const response = await put({ workspace });
    expect(response.status).toBe(401);
    expect(mockCheckSessionAccess).not.toHaveBeenCalled();
  });
});
