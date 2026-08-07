// @vitest-environment node
/**
 * GET/PUT `/api/agent-sessions/[sessionId]/workspace` — what matters here is
 * the not-found/denied family policy (SAME null-workspace answer on GET, a
 * uniform 404 on PUT) and that the retired PUT answers 410 for every
 * reachable session without touching storage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuthenticateRequest,
  mockAuditRequest,
  mockCheckSessionAccess,
  mockReadWorkspaceLayoutSnapshot,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockAuditRequest: vi.fn(),
  mockCheckSessionAccess: vi.fn(),
  mockReadWorkspaceLayoutSnapshot: vi.fn(),
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
// `workspaceListEntryFromGrid` is the REAL pure projection: this suite's whole
// point on GET is that the older whole-state `workspace` field is now derived
// from the same rows the snapshot serves, so mocking it would test nothing.
vi.mock('@/lib/agent-sessions/workspace-layout-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent-sessions/workspace-layout-runtime')>()),
  readWorkspaceLayoutSnapshot: (...args: unknown[]) => mockReadWorkspaceLayoutSnapshot(...args),
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
  mockReadWorkspaceLayoutSnapshot.mockResolvedValue({ rev: 0, grid: null });
});

describe('GET /api/agent-sessions/[sessionId]/workspace', () => {
  it('derives the whole-state `workspace` field from the SAME rows as rev + grid', async () => {
    mockReadWorkspaceLayoutSnapshot.mockResolvedValue({ rev: 3, grid: workspace.columns });
    const response = await get();
    expect(response.status).toBe(200);
    // Byte-identical to what the blob used to serve, except that focus is a
    // default now (first pane) rather than a restored fact — the column that
    // stored it is gone.
    expect(await response.json()).toEqual({ workspace, rev: 3, grid: workspace.columns });
  });

  it('returns null workspace/grid for a session with no grid', async () => {
    const response = await get();
    expect(await response.json()).toEqual({ workspace: null, rev: 0, grid: null });
  });

  it('returns null (not 404) for a session the requester cannot reach — same answer as not-found', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'drive_access_denied' });
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workspace: null, rev: 0, grid: null });
    expect(mockReadWorkspaceLayoutSnapshot).not.toHaveBeenCalled();
  });

  it('given an auth failure, returns the auth error untouched', async () => {
    const error = new Response(null, { status: 401 });
    mockAuthenticateRequest.mockResolvedValue({ error });
    const response = await get();
    expect(response.status).toBe(401);
    expect(mockCheckSessionAccess).not.toHaveBeenCalled();
  });
});

describe('PUT /api/agent-sessions/[sessionId]/workspace (retired)', () => {
  it('410s a well-formed write — the endpoint is gone, and says so rather than pretending to save', async () => {
    const response = await put({ workspace });
    // NOT 200: a stale deployed client (pre-#2345, still debouncing this PUT)
    // must never be told its layout persisted when nothing was stored.
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      error: expect.stringContaining('/workspace/verbs'),
    });
    // No write happened, so there is no data.write to audit.
    expect(mockAuditRequest).not.toHaveBeenCalled();
  });

  it('410s a malformed body too — there is no payload worth validating any more', async () => {
    expect((await put({ workspace: { id: 'ses-1', columns: [] } })).status).toBe(410);
    expect((await put(undefined)).status).toBe(410);
    expect((await put({ workspace: { ...workspace, id: 'ses-OTHER' } })).status).toBe(410);
  });

  it('404s an unknown session — the retirement notice is not a session-existence oracle', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'session_not_found' });
    const response = await put({ workspace });
    expect(response.status).toBe(404);
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

  it('given an auth failure, returns the auth error untouched', async () => {
    const error = new Response(null, { status: 401 });
    mockAuthenticateRequest.mockResolvedValue({ error });
    const response = await put({ workspace });
    expect(response.status).toBe(401);
    expect(mockCheckSessionAccess).not.toHaveBeenCalled();
  });
});
