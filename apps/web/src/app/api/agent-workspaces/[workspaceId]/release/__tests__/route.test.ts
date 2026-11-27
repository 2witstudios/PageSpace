// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuthenticateRequest,
  mockAuditRequest,
  mockCheckSessionEndAccess,
  mockReleaseAutoProvisionedConversations,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockAuditRequest: vi.fn(),
  mockCheckSessionEndAccess: vi.fn(),
  mockReleaseAutoProvisionedConversations: vi.fn(),
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
  releaseAutoProvisionedConversations: (...args: unknown[]) => mockReleaseAutoProvisionedConversations(...args),
}));

import { POST } from '../route';

const SESSION_ID = 'ses-1';
const params = { params: Promise.resolve({ workspaceId: SESSION_ID }) };
const release = () => POST(new Request(`http://localhost/api/agent-workspaces/${SESSION_ID}/release`, { method: 'POST' }), params);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue({ userId: 'user-1', role: 'user' });
  mockCheckSessionEndAccess.mockResolvedValue({ allowed: true });
  mockReleaseAutoProvisionedConversations.mockResolvedValue(2);
});

describe('POST /api/agent-workspaces/[workspaceId]/release', () => {
  it('given the END access check passes, should release the caller\'s auto-provisioned threads AS the caller and report how many', async () => {
    const response = await release();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, releasedConversations: 2 });
    expect(mockCheckSessionEndAccess).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }), SESSION_ID);
    expect(mockReleaseAutoProvisionedConversations).toHaveBeenCalledWith({
      workspaceId: SESSION_ID,
      actor: expect.objectContaining({ userId: 'user-1' }),
    });
  });

  it('given the END access check refuses, should release NOTHING — the same gate as ending the session, always applied first', async () => {
    mockCheckSessionEndAccess.mockResolvedValue({ allowed: false, reason: 'not_found' });
    const response = await release();
    expect(response.status).toBe(404);
    expect(mockReleaseAutoProvisionedConversations).not.toHaveBeenCalled();
  });

  it('given an unauthenticated request, should release nothing', async () => {
    mockAuthenticateRequest.mockResolvedValue({ error: new Response(null, { status: 401 }) });
    const response = await release();
    expect(response.status).toBe(401);
    expect(mockCheckSessionEndAccess).not.toHaveBeenCalled();
    expect(mockReleaseAutoProvisionedConversations).not.toHaveBeenCalled();
  });

  it('given the release itself failing, should answer 500 and say so', async () => {
    mockReleaseAutoProvisionedConversations.mockRejectedValue(new Error('db blip'));
    const response = await release();
    expect(response.status).toBe(500);
  });
});
