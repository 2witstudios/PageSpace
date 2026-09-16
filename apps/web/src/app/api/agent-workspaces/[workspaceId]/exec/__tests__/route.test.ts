// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuthenticateRequest,
  mockAuditSessionAccessDenial,
  mockCheckSessionAccess,
  mockFindSessionRecord,
  mockResolveActorContext,
  mockExecInWorkspace,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockAuditSessionAccessDenial: vi.fn(),
  mockCheckSessionAccess: vi.fn(),
  mockFindSessionRecord: vi.fn(),
  mockResolveActorContext: vi.fn(),
  mockExecInWorkspace: vi.fn(),
}));

// The REAL credential-scope helper runs against these: getAllowedDriveIds is
// the only auth fact it reads, so the scope decision under test is not mocked.
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequest(...args),
  isAuthError: (result: unknown) => result != null && typeof result === 'object' && 'error' in result,
  isManageKeysOnly: (auth: { manageKeysOnly?: boolean }) => auth.manageKeysOnly === true,
  getAllowedDriveIds: (auth: { allowedDriveIds?: string[] }) => auth.allowedDriveIds ?? [],
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { error: vi.fn(), warn: vi.fn() } },
}));
vi.mock('@/lib/agent-workspaces/agent-workspaces-runtime', () => ({
  checkSessionAccess: (...args: unknown[]) => mockCheckSessionAccess(...args),
  findSessionRecord: (...args: unknown[]) => mockFindSessionRecord(...args),
}));
vi.mock('@/lib/agent-workspaces/workspace-unavailable-response', () => ({
  auditSessionAccessDenial: (...args: unknown[]) => mockAuditSessionAccessDenial(...args),
}));
vi.mock('@/lib/agent-workspaces/workspace-exec-runtime', () => ({
  resolveWorkspaceExecActorContext: (...args: unknown[]) => mockResolveActorContext(...args),
  execInWorkspace: (...args: unknown[]) => mockExecInWorkspace(...args),
}));

import { POST } from '../route';

const WORKSPACE_ID = 'ws-1';
const ROW = { id: WORKSPACE_ID, ownerId: 'user-1', driveId: 'drive-1', endedAt: null };
const CTX = { userId: 'user-1', tenantId: 'owner-1', conversationId: `workspace-exec:${WORKSPACE_ID}` };

const params = { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) };
const post = (body: unknown) =>
  POST(
    new Request(`http://localhost/api/agent-workspaces/${WORKSPACE_ID}/exec`, {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    params,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue({ userId: 'user-1', tokenType: 'session' });
  mockCheckSessionAccess.mockResolvedValue({ allowed: true });
  mockFindSessionRecord.mockResolvedValue(ROW);
  mockResolveActorContext.mockResolvedValue(CTX);
  mockExecInWorkspace.mockResolvedValue({ success: true, stdout: 'hi\n', stderr: '', exitCode: 3, truncated: false });
});

describe('POST /api/agent-workspaces/[workspaceId]/exec', () => {
  it('given an accessible workspace, should run the command and answer its output with a 200 even for a non-zero exit', async () => {
    const response = await post({ command: 'echo hi; exit 3', cwd: 'repo', timeoutMs: 5000 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stdout: 'hi\n', stderr: '', exitCode: 3, truncated: false });
    expect(mockExecInWorkspace).toHaveBeenCalledWith({
      session: ROW,
      ctx: CTX,
      command: 'echo hi; exit 3',
      cwd: 'repo',
      timeoutMs: 5000,
    });
  });

  it('should accept session AND mcp credentials, with CSRF for cookies', async () => {
    await post({ command: 'true' });
    expect(mockAuthenticateRequest).toHaveBeenCalledWith(expect.anything(), {
      allow: ['session', 'mcp'],
      requireCSRF: true,
    });
  });

  it('given an auth error, should answer it without touching the workspace', async () => {
    mockAuthenticateRequest.mockResolvedValue({ error: new Response(null, { status: 401 }) });
    const response = await post({ command: 'true' });
    expect(response.status).toBe(401);
    expect(mockCheckSessionAccess).not.toHaveBeenCalled();
  });

  it('given input the bash tool schema rejects, should 400 before any access check', async () => {
    const response = await post({ command: '', extra: 1 });
    expect(response.status).toBe(400);
    expect((await response.json()).reason).toBe('invalid_input');
    expect(mockCheckSessionAccess).not.toHaveBeenCalled();
    expect(mockExecInWorkspace).not.toHaveBeenCalled();
  });

  it('given a malformed JSON body, should 400', async () => {
    const response = await post('{not json');
    expect(response.status).toBe(400);
  });

  it('given a denied workspace, should answer the family 404 and audit the denial', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'code_execution_denied' });
    const response = await post({ command: 'true' });
    expect(response.status).toBe(404);
    expect(mockAuditSessionAccessDenial).toHaveBeenCalled();
    expect(mockExecInWorkspace).not.toHaveBeenCalled();
  });

  it('given an ended workspace, should 404 and never run', async () => {
    mockFindSessionRecord.mockResolvedValue({ ...ROW, endedAt: new Date() });
    const response = await post({ command: 'true' });
    expect(response.status).toBe(404);
    expect(mockExecInWorkspace).not.toHaveBeenCalled();
  });

  it('given a token scoped to another drive, should answer the SAME 404 and never run', async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: 'user-1', tokenType: 'mcp', allowedDriveIds: ['drive-other'] });
    const response = await post({ command: 'true' });
    expect(response.status).toBe(404);
    expect(mockExecInWorkspace).not.toHaveBeenCalled();
    expect(mockAuditSessionAccessDenial).toHaveBeenCalledWith(
      expect.anything(), 'user-1', WORKSPACE_ID, 'credential_out_of_scope', expect.any(String),
    );
  });

  it('given a drive-scoped token and a DRIVELESS workspace, should 404 — a driveless workspace is in no drive scope', async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: 'user-1', tokenType: 'mcp', allowedDriveIds: ['drive-1'] });
    mockFindSessionRecord.mockResolvedValue({ ...ROW, driveId: null });
    const response = await post({ command: 'true' });
    expect(response.status).toBe(404);
    expect(mockExecInWorkspace).not.toHaveBeenCalled();
  });

  it('given a manage-keys-only credential, should 404', async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: 'user-1', tokenType: 'mcp', manageKeysOnly: true });
    const response = await post({ command: 'true' });
    expect(response.status).toBe(404);
    expect(mockExecInWorkspace).not.toHaveBeenCalled();
  });

  it('given a token scoped to the workspace drive, should run', async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: 'user-1', tokenType: 'mcp', allowedDriveIds: ['drive-1'] });
    const response = await post({ command: 'true' });
    expect(response.status).toBe(200);
    expect(mockExecInWorkspace).toHaveBeenCalled();
  });

  it.each([
    ['tier_ineligible', 403],
    ['concurrency_limit', 429],
    ['credit_exhausted', 402],
    ['blocked_metadata_access', 400],
    ['provision_failed', 503],
    ['kill_switch_off', 403],
  ])('given a %s refusal, should answer %i with the reason', async (reason, status) => {
    mockExecInWorkspace.mockResolvedValue({ success: false, error: 'nope', reason, retryAfter: 7 });
    const response = await post({ command: 'true' });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: 'nope', reason, retryAfter: 7 });
  });

  it('given an actor-context failure, should 403 and never run', async () => {
    mockResolveActorContext.mockResolvedValue({ error: 'Code execution requires an active drive.' });
    const response = await post({ command: 'true' });
    expect(response.status).toBe(403);
    expect(mockExecInWorkspace).not.toHaveBeenCalled();
  });

  it('given a thrown runtime fault, should 500 without leaking it', async () => {
    mockExecInWorkspace.mockRejectedValue(new Error('sprite exploded'));
    const response = await post({ command: 'true' });
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('sprite exploded');
  });
});
