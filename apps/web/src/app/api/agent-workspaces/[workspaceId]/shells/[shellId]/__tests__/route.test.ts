// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuthenticateRequest,
  mockAuditRequest,
  mockCheckSessionEndAccess,
  mockKillShellById,
  mockResolveShellById,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockAuditRequest: vi.fn(),
  mockCheckSessionEndAccess: vi.fn(),
  mockKillShellById: vi.fn(),
  mockResolveShellById: vi.fn(),
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
vi.mock('@/lib/agent-workspaces/agent-workspaces-runtime', () => ({
  checkSessionEndAccess: (...args: unknown[]) => mockCheckSessionEndAccess(...args),
}));
vi.mock('@/lib/agent-workspaces/workspace-shells-runtime', () => ({
  killShellById: (...args: unknown[]) => mockKillShellById(...args),
  resolveShellById: (...args: unknown[]) => mockResolveShellById(...args),
}));

import { DELETE } from '../route';

const AUTH_USER = { userId: 'user-1', role: 'admin' };
const SESSION_ID = 'conv-1';
const SHELL_ID = 'shell-row-1';
const SHELL = { shellId: SHELL_ID, workspaceId: SESSION_ID, ownerId: 'user-1', name: 'shell-1', agentType: 'shell', command: null, createdAt: 'x' };

const del = (workspaceId = SESSION_ID, shellId = SHELL_ID) =>
  DELETE(new Request(`http://localhost/api/agent-workspaces/${workspaceId}/shells/${shellId}`, { method: 'DELETE' }), {
    params: Promise.resolve({ workspaceId, shellId }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue(AUTH_USER);
  mockResolveShellById.mockResolvedValue({ ok: true, shell: SHELL, cwd: '/workspace', spriteExecId: null });
  mockCheckSessionEndAccess.mockResolvedValue({ allowed: true });
  mockKillShellById.mockResolvedValue({ ok: true, killed: true });
});

describe('DELETE /api/agent-workspaces/[workspaceId]/shells/[shellId]', () => {
  it('should kill the shell and report it', async () => {
    const response = await del();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, killed: true });
    // Addressed by shell AND by the acting human: the kill takes the shell's
    // pane with it through the membership funnel, which never takes a caller's
    // word for who is acting (#2462).
    expect(mockKillShellById).toHaveBeenCalledWith({ shellId: SHELL_ID, actingUserId: 'user-1' });
  });

  it('given a shell that is already gone, should 404 — which the client treats as success', async () => {
    mockResolveShellById.mockResolvedValue({ ok: false, reason: 'not_found' });
    const response = await del();
    expect(response.status).toBe(404);
    expect(mockKillShellById).not.toHaveBeenCalled();
  });

  it('given a shell under a DIFFERENT session than the URL claims, should 404 without leaking the pairing', async () => {
    mockResolveShellById.mockResolvedValue({
      ok: true,
      shell: { ...SHELL, workspaceId: 'someone-elses-session' },
      cwd: '/workspace',
      spriteExecId: null,
    });
    const response = await del();
    expect(response.status).toBe(404);
    expect(mockKillShellById).not.toHaveBeenCalled();
    expect(mockCheckSessionEndAccess).not.toHaveBeenCalled();
  });

  it('should authorize against the shell\'s OWN session with the END check (no capability gate)', async () => {
    await del();
    expect(mockCheckSessionEndAccess).toHaveBeenCalledWith('user-1', SESSION_ID);
  });

  it('given a denial, should 404 (SAME as not-found, review #2261/5), audit it, and kill nothing', async () => {
    mockCheckSessionEndAccess.mockResolvedValue({ allowed: false, reason: 'not_shared' });
    const response = await del();
    expect(response.status).toBe(404);
    expect(mockKillShellById).not.toHaveBeenCalled();
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'authz.access.denied' }),
    );
  });

  it('given a kill that could not be confirmed, should 502 so the caller retries (row kept)', async () => {
    mockKillShellById.mockResolvedValue({ ok: false, reason: 'error' });
    const response = await del();
    expect(response.status).toBe(502);
  });
});
