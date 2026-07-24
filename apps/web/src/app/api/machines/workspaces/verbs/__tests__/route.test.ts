/**
 * Contract tests for POST /api/machines/workspaces/verbs
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuthenticateRequest,
  mockIsAuthError,
  mockCanAccessMachine,
  mockApplyWorkspaceVerbLocked,
  mockBroadcastWorkspaceVerbResult,
  mockAuditRequest,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockIsAuthError: vi.fn((result: unknown) => result != null && typeof result === 'object' && 'error' in result),
  mockCanAccessMachine: vi.fn(),
  mockApplyWorkspaceVerbLocked: vi.fn(),
  mockBroadcastWorkspaceVerbResult: vi.fn(),
  mockAuditRequest: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequest(...args),
  isAuthError: (result: unknown) => mockIsAuthError(result),
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: (...args: unknown[]) => mockAuditRequest(...args),
}));

// `parseWorkspaceVerb` is pure (no I/O) — reused via `importOriginal` rather
// than re-implemented; only the DB-backed pieces are mocked.
vi.mock('@/lib/machines/workspace-verbs-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/machines/workspace-verbs-runtime')>();
  return {
    ...actual,
    applyWorkspaceVerbLocked: (...args: unknown[]) => mockApplyWorkspaceVerbLocked(...args),
    broadcastWorkspaceVerbResult: (...args: unknown[]) => mockBroadcastWorkspaceVerbResult(...args),
  };
});

vi.mock('@/lib/machines/machine-workspaces-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/machines/machine-workspaces-runtime')>();
  return {
    ...actual,
    canAccessMachine: (...args: unknown[]) => mockCanAccessMachine(...args),
  };
});

import { POST } from '../route';

const AUTH_OK = { userId: 'user-1' };
const AUTH_DENIED = { error: new Response(null, { status: 401 }) };

function req(body: unknown) {
  return new Request('https://x.test/api/machines/workspaces/verbs', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue(AUTH_OK);
  mockCanAccessMachine.mockResolvedValue(true);
});

describe('POST /api/machines/workspaces/verbs', () => {
  it('given no auth, returns the auth error', async () => {
    mockAuthenticateRequest.mockResolvedValue(AUTH_DENIED);
    const res = await POST(req({ machineId: 't1', verb: { type: 'rename-workspace', workspaceId: 'ws-1', name: 'X' } }));
    expect(res.status).toBe(401);
  });

  it('given no machineId, returns 400 without checking access', async () => {
    const res = await POST(req({ verb: { type: 'rename-workspace', workspaceId: 'ws-1', name: 'X' } }));
    expect(res.status).toBe(400);
    expect(mockCanAccessMachine).not.toHaveBeenCalled();
  });

  it('given a malformed verb body, returns 400 without checking access', async () => {
    const res = await POST(req({ machineId: 't1', verb: { type: 'not-a-real-verb' } }));
    expect(res.status).toBe(400);
    expect(mockCanAccessMachine).not.toHaveBeenCalled();
  });

  it('given no edit access, returns 403 without applying', async () => {
    mockCanAccessMachine.mockResolvedValue(false);
    const res = await POST(req({ machineId: 't1', verb: { type: 'rename-workspace', workspaceId: 'ws-1', name: 'X' } }));
    expect(res.status).toBe(403);
    expect(mockApplyWorkspaceVerbLocked).not.toHaveBeenCalled();
  });

  it('given a successful apply, returns 200, broadcasts, and audits data.write', async () => {
    mockApplyWorkspaceVerbLocked.mockResolvedValue({ ok: true, rev: 3, workspaceId: 'ws-1', applied: true, workspace: { id: 'ws-1' } });
    const res = await POST(req({ machineId: 't1', verb: { type: 'rename-workspace', workspaceId: 'ws-1', name: 'Renamed' } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ rev: 3, workspaceId: 'ws-1', workspace: { id: 'ws-1' }, applied: true });
    expect(mockBroadcastWorkspaceVerbResult).toHaveBeenCalledWith('t1', expect.objectContaining({ type: 'rename-workspace' }), expect.objectContaining({ applied: true }));
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'data.write', resourceId: 't1', details: { workspaceId: 'ws-1', verb: 'rename-workspace' } }),
    );
  });

  it('given an idempotent no-op apply, returns 200 without auditing a write', async () => {
    mockApplyWorkspaceVerbLocked.mockResolvedValue({ ok: true, rev: 3, workspaceId: 'ws-1', applied: false, workspace: { id: 'ws-1' } });
    const res = await POST(req({ machineId: 't1', verb: { type: 'rename-workspace', workspaceId: 'ws-1', name: 'Renamed' } }));
    expect(res.status).toBe(200);
    expect(mockAuditRequest).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'data.write' }));
  });

  it('given a denial reason from applyWorkspaceVerb, maps it to the right status', async () => {
    mockApplyWorkspaceVerbLocked.mockResolvedValue({ ok: false, reason: 'invalid_name' });
    const res = await POST(req({ machineId: 't1', verb: { type: 'rename-workspace', workspaceId: 'ws-1', name: 'Renamed' } }));
    expect(res.status).toBe(400);
  });

  it('given a not_found denial, returns 404', async () => {
    mockApplyWorkspaceVerbLocked.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await POST(req({ machineId: 't1', verb: { type: 'rename-workspace', workspaceId: 'ws-1', name: 'Renamed' } }));
    expect(res.status).toBe(404);
  });
});
