// @vitest-environment node
/**
 * The session-scoped conversation-close route. What matters here: the
 * uniform 404 for an unreachable session AND for a conversation this session
 * does not own, the 409 + reason on the never-empty guard, and that a mere
 * idempotent re-close (already_closed) still answers 200 without a fresh
 * audit write.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAuthenticateRequest, mockAuditRequest, mockCheckSessionAccess, mockCloseConversationInSession } =
  vi.hoisted(() => ({
    mockAuthenticateRequest: vi.fn(),
    mockAuditRequest: vi.fn(),
    mockCheckSessionAccess: vi.fn(),
    mockCloseConversationInSession: vi.fn(),
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
  closeConversationInSession: (...args: unknown[]) => mockCloseConversationInSession(...args),
}));

import { DELETE } from '../route';

const AUTH_USER = { userId: 'user-1', role: 'admin' };
const SESSION_ID = 'ses-1';
const CONVERSATION_ID = 'conv-1';

const params = { params: Promise.resolve({ workspaceId: SESSION_ID, conversationId: CONVERSATION_ID }) };
const del = () =>
  DELETE(
    new Request(`http://localhost/api/agent-workspaces/${SESSION_ID}/conversations/${CONVERSATION_ID}`, {
      method: 'DELETE',
    }),
    params,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue(AUTH_USER);
  mockCheckSessionAccess.mockResolvedValue({ allowed: true });
  mockCloseConversationInSession.mockResolvedValue('closed');
});

describe('DELETE /api/agent-workspaces/[workspaceId]/conversations/[conversationId]', () => {
  it('closes an open listing', async () => {
    const response = await del();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    // The CALLER's id travels with the request: `checkSessionAccess` above
    // authorizes the SESSION (drive-membership-wide, so any member reaches
    // another member's session), which is not ownership of the CONVERSATION.
    // The primitive runs that second gate, and can only do so if the route
    // passes the caller through.
    expect(mockCloseConversationInSession).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      userId: AUTH_USER.userId,
      workspaceId: SESSION_ID,
    });
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'data.write', details: expect.objectContaining({ op: 'close_conversation' }) }),
    );
  });

  it('an idempotent re-close (already_closed) still answers 200, with no fresh data.write audit', async () => {
    mockCloseConversationInSession.mockResolvedValue('already_closed');
    const response = await del();
    expect(response.status).toBe(200);
    expect(mockAuditRequest).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'data.write' }),
    );
  });

  it('404s an unknown session — same shape whether it never existed or is denied', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'session_not_found' });
    const response = await del();
    expect(response.status).toBe(404);
    expect(mockCloseConversationInSession).not.toHaveBeenCalled();
  });

  it('404s a session the requester cannot reach, but still audits the denial', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'drive_access_denied' });
    const response = await del();
    expect(response.status).toBe(404);
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'authz.access.denied' }),
    );
  });

  it('404s a conversation this session does not own (not_in_session) — session access alone is not enough', async () => {
    mockCloseConversationInSession.mockResolvedValue('not_in_session');
    const response = await del();
    expect(response.status).toBe(404);
  });

  it("409s the session's LAST open listing, as a rate-limit refusal rather than an authz denial", async () => {
    mockCloseConversationInSession.mockResolvedValue('last_conversation');
    const response = await del();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(
      expect.objectContaining({ reason: 'last_conversation' }),
    );
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'security.rate.limited' }),
    );
  });

  it('500s a thrown failure with a human error — a pure DB transaction, no sandbox layer to blame', async () => {
    mockCloseConversationInSession.mockRejectedValue(new Error('db exploded'));
    const response = await del();
    expect(response.status).toBe(500);
  });

  it('given an auth failure, should return the auth error untouched', async () => {
    const error = new Response(null, { status: 401 });
    mockAuthenticateRequest.mockResolvedValue({ error });
    const response = await del();
    expect(response.status).toBe(401);
    expect(mockCheckSessionAccess).not.toHaveBeenCalled();
  });
});
