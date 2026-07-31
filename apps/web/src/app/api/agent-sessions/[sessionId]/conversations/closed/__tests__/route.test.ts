// @vitest-environment node
/**
 * A session's CLOSED conversations — the reopen affordance's source list.
 * What matters here: the uniform 404 for an unreachable session (same shape
 * as every WRITE route in this family — `sessionNotFoundOrDenied`, not the
 * GET-`[sessionId]`-only `{ session: null }`/200 convention), and that the
 * runtime's listing passes through untouched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAuthenticateRequest, mockAuditRequest, mockCheckSessionAccess, mockListClosedSessionConversations } =
  vi.hoisted(() => ({
    mockAuthenticateRequest: vi.fn(),
    mockAuditRequest: vi.fn(),
    mockCheckSessionAccess: vi.fn(),
    mockListClosedSessionConversations: vi.fn(),
  }));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequest(...args),
  isAuthError: (result: unknown) => result != null && typeof result === 'object' && 'error' in result,
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: (...args: unknown[]) => mockAuditRequest(...args),
}));
vi.mock('@/lib/agent-sessions/agent-sessions-runtime', () => ({
  checkSessionAccess: (...args: unknown[]) => mockCheckSessionAccess(...args),
  listClosedSessionConversations: (...args: unknown[]) => mockListClosedSessionConversations(...args),
}));

import { GET } from '../route';

const AUTH_USER = { userId: 'user-1', role: 'admin' };
const SESSION_ID = 'ses-1';
const CONVERSATIONS = [{ conversationId: 'conv-1', title: 'Old chat', agentPageId: 'agent-1', lastMessageAt: null }];

const params = { params: Promise.resolve({ sessionId: SESSION_ID }) };
const get = () => GET(new Request(`http://localhost/api/agent-sessions/${SESSION_ID}/conversations/closed`), params);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue(AUTH_USER);
  mockCheckSessionAccess.mockResolvedValue({ allowed: true });
  mockListClosedSessionConversations.mockResolvedValue(CONVERSATIONS);
});

describe('GET /api/agent-sessions/[sessionId]/conversations/closed', () => {
  it('returns the session\'s closed conversations', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ conversations: CONVERSATIONS });
    expect(mockListClosedSessionConversations).toHaveBeenCalledWith(SESSION_ID);
  });

  it('returns an empty list, not an error, when the session has nothing closed', async () => {
    mockListClosedSessionConversations.mockResolvedValue([]);
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ conversations: [] });
  });

  it('404s an unknown session — same shape whether it never existed or is denied (this family\'s write-route convention, not GET [sessionId]\'s own { session: null })', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'session_not_found' });
    const response = await get();
    expect(response.status).toBe(404);
    expect(mockListClosedSessionConversations).not.toHaveBeenCalled();
  });

  it('404s a session the requester cannot reach, but still audits the denial', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'drive_access_denied' });
    const response = await get();
    expect(response.status).toBe(404);
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'authz.access.denied' }),
    );
  });

  it('given an auth failure, should return the auth error untouched', async () => {
    const error = new Response(null, { status: 401 });
    mockAuthenticateRequest.mockResolvedValue({ error });
    const response = await get();
    expect(response.status).toBe(401);
    expect(mockCheckSessionAccess).not.toHaveBeenCalled();
  });
});
