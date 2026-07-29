// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuthenticateRequest,
  mockAuditRequest,
  mockCheckSessionAccess,
  mockCheckSessionEndAccess,
  mockCheckAccessForSubject,
  mockEnsureSession,
  mockEndSession,
  mockFindSessionConversation,
  mockFindSessionRecord,
  mockProvisionSessionSandbox,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockAuditRequest: vi.fn(),
  mockCheckSessionAccess: vi.fn(),
  mockCheckSessionEndAccess: vi.fn(),
  mockCheckAccessForSubject: vi.fn(),
  mockEnsureSession: vi.fn(),
  mockEndSession: vi.fn(),
  mockFindSessionConversation: vi.fn(),
  mockFindSessionRecord: vi.fn(),
  mockProvisionSessionSandbox: vi.fn(),
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
  checkSessionEndAccess: (...args: unknown[]) => mockCheckSessionEndAccess(...args),
  checkAccessForSubject: (...args: unknown[]) => mockCheckAccessForSubject(...args),
  ensureSession: (...args: unknown[]) => mockEnsureSession(...args),
  endSession: (...args: unknown[]) => mockEndSession(...args),
  findSessionConversation: (...args: unknown[]) => mockFindSessionConversation(...args),
  findSessionRecord: (...args: unknown[]) => mockFindSessionRecord(...args),
  provisionSessionSandbox: (...args: unknown[]) => mockProvisionSessionSandbox(...args),
  toAgentSessionDTO: (row: { conversationId: string }) => ({ sessionId: row.conversationId, dto: true }),
}));

import { GET, POST, DELETE } from '../route';

const AUTH_USER = { userId: 'user-1', role: 'admin' };
const SESSION_ID = 'conv-1';
const ROW = { conversationId: SESSION_ID, ownerId: 'user-1', agentPageId: 'page-1' };
const CONVERSATION = { userId: 'user-1', type: 'page', contextId: 'page-1', isShared: false };

const params = { params: Promise.resolve({ sessionId: SESSION_ID }) };
const get = () => GET(new Request(`http://localhost/api/agent-sessions/${SESSION_ID}`), params);
const post = () => POST(new Request(`http://localhost/api/agent-sessions/${SESSION_ID}`, { method: 'POST' }), params);
const del = () => DELETE(new Request(`http://localhost/api/agent-sessions/${SESSION_ID}`, { method: 'DELETE' }), params);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue(AUTH_USER);
  mockCheckSessionAccess.mockResolvedValue({ allowed: true });
  mockCheckSessionEndAccess.mockResolvedValue({ allowed: true });
  mockCheckAccessForSubject.mockResolvedValue({ allowed: true });
  mockFindSessionConversation.mockResolvedValue(CONVERSATION);
  mockFindSessionRecord.mockResolvedValue(ROW);
  mockEnsureSession.mockResolvedValue({ ok: true, session: ROW });
  mockProvisionSessionSandbox.mockResolvedValue({ ok: true, sandboxId: 'sb-1', resumed: false });
  mockEndSession.mockResolvedValue({ ok: true, spriteTornDown: true });
});

describe('GET /api/agent-sessions/[sessionId]', () => {
  it('given an accessible session, should return its DTO', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ session: { sessionId: SESSION_ID, dto: true } });
  });

  it('given a never-provisioned session (no row), should answer { session: null } with 200 — NOT 404', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'session_not_found' });
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ session: null });
  });

  it('given a denial, should 403 and audit it', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'page_access_denied' });
    const response = await get();
    expect(response.status).toBe(403);
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'authz.access.denied' }),
    );
  });
});

describe('POST /api/agent-sessions/[sessionId]', () => {
  it('should ensure the row AS THE CONVERSATION OWNER, provision, and return the DTO', async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ session: { sessionId: SESSION_ID, dto: true } });
    expect(mockEnsureSession).toHaveBeenCalledWith({
      conversationId: SESSION_ID,
      userId: 'user-1',
      agentPageId: 'page-1',
    });
    expect(mockProvisionSessionSandbox).toHaveBeenCalledWith(ROW, 'user-1');
  });

  it('given a GLOBAL conversation, should anchor with agentPageId null', async () => {
    mockFindSessionConversation.mockResolvedValue({ userId: 'user-1', type: 'global', contextId: null, isShared: false });
    await post();
    expect(mockEnsureSession).toHaveBeenCalledWith(
      expect.objectContaining({ agentPageId: null }),
    );
  });

  it('given a conversation that does not exist, should 404 and never ensure or provision', async () => {
    mockFindSessionConversation.mockResolvedValue(null);
    const response = await post();
    expect(response.status).toBe(404);
    expect(mockEnsureSession).not.toHaveBeenCalled();
    expect(mockProvisionSessionSandbox).not.toHaveBeenCalled();
  });

  it('given a conversation type that cannot host a session, should 409', async () => {
    mockFindSessionConversation.mockResolvedValue({ userId: 'user-1', type: 'drive', contextId: 'drive-1', isShared: false });
    const response = await post();
    expect(response.status).toBe(409);
    expect(mockEnsureSession).not.toHaveBeenCalled();
  });

  it('given an access denial on the row-to-be, should 403 BEFORE ensuring anything', async () => {
    mockCheckAccessForSubject.mockResolvedValue({ allowed: false, reason: 'code_execution_denied' });
    const response = await post();
    expect(response.status).toBe(403);
    expect(mockEnsureSession).not.toHaveBeenCalled();
    expect(mockProvisionSessionSandbox).not.toHaveBeenCalled();
  });

  it('given a PLAN-LIMIT refusal, should 429 — not the 403 an authorization failure gets', async () => {
    // The distinction this PR spent several rounds getting right, finally pinned
    // at the route: a quota refusal is a quantity limit (429, `security.rate.limited`,
    // worded in the UI's vocabulary), never an access denial. The `route` tag is
    // asserted because extracting the duplicated helper made it a parameter.
    mockProvisionSessionSandbox.mockResolvedValue({
      ok: false,
      reason: 'denied',
      denial: 'session_limit_reached',
    });

    const response = await post();

    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error).toContain('sandbox');
    expect(body.error.toLowerCase()).not.toContain('session');
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'security.rate.limited',
        details: expect.objectContaining({
          reason: 'session_limit_reached',
          route: 'agent-sessions/[sessionId]',
        }),
      }),
    );
  });

  it('given a provisioning denial, should 403 with the audit trail', async () => {
    mockProvisionSessionSandbox.mockResolvedValue({ ok: false, reason: 'denied', denial: 'not_authorized' });
    const response = await post();
    expect(response.status).toBe(403);
  });

  it('given a provisioning failure, should 502 with the reason token', async () => {
    mockProvisionSessionSandbox.mockResolvedValue({ ok: false, reason: 'provision_failed', detail: 'boom' });
    const response = await post();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual(
      expect.objectContaining({ reason: 'provision_failed' }),
    );
  });

  it('given the squat guard refusing the conversation, should 409', async () => {
    mockEnsureSession.mockResolvedValue({ ok: false, reason: 'conversation_unavailable' });
    const response = await post();
    expect(response.status).toBe(409);
    expect(mockProvisionSessionSandbox).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/agent-sessions/[sessionId]', () => {
  it('should end the session (row retained) and report the teardown', async () => {
    const response = await del();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, spriteTornDown: true });
    expect(mockEndSession).toHaveBeenCalledWith(SESSION_ID);
  });

  it('should gate on the END access check — the one WITHOUT the capability gate', async () => {
    await del();
    expect(mockCheckSessionEndAccess).toHaveBeenCalledWith('user-1', SESSION_ID);
    expect(mockCheckSessionAccess).not.toHaveBeenCalled();
  });

  it('given no such session, should 404', async () => {
    mockCheckSessionEndAccess.mockResolvedValue({ allowed: false, reason: 'session_not_found' });
    const response = await del();
    expect(response.status).toBe(404);
    expect(mockEndSession).not.toHaveBeenCalled();
  });

  it('given a denial, should 403 and never touch the session', async () => {
    mockCheckSessionEndAccess.mockResolvedValue({ allowed: false, reason: 'not_shared' });
    const response = await del();
    expect(response.status).toBe(403);
    expect(mockEndSession).not.toHaveBeenCalled();
  });

  it('given a teardown failure, should 502 so the caller can retry', async () => {
    mockEndSession.mockResolvedValue({ ok: false, reason: 'teardown_failed', detail: 'kill failed' });
    const response = await del();
    expect(response.status).toBe(502);
  });
});
