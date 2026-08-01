// @vitest-environment node
/**
 * The session-scoped conversation-claim route — the "open into a session"
 * affordance for a conversation that never had one. What matters here: the
 * uniform 404 for an unreachable session AND for a conversation unavailable
 * to claim (missing, foreign, already bound elsewhere), the 429 on the cap,
 * the 400 on a cross-drive mismatch, the 409 on an ended session, and that
 * an idempotent re-claim (already_in_session) still answers 200 without a
 * fresh audit write — mirrors `../../reopen/__tests__/route.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAuthenticateRequest, mockAuditRequest, mockCheckSessionAccess, mockClaimConversationInSession } =
  vi.hoisted(() => ({
    mockAuthenticateRequest: vi.fn(),
    mockAuditRequest: vi.fn(),
    mockCheckSessionAccess: vi.fn(),
    mockClaimConversationInSession: vi.fn(),
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
  claimConversationInSession: (...args: unknown[]) => mockClaimConversationInSession(...args),
}));

import { POST } from '../route';

const AUTH_USER = { userId: 'user-1', role: 'admin' };
const SESSION_ID = 'ses-1';
const CONVERSATION_ID = 'conv-1';

const params = { params: Promise.resolve({ sessionId: SESSION_ID, conversationId: CONVERSATION_ID }) };
const post = () =>
  POST(
    new Request(`http://localhost/api/agent-sessions/${SESSION_ID}/conversations/${CONVERSATION_ID}/claim`, {
      method: 'POST',
    }),
    params,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue(AUTH_USER);
  mockCheckSessionAccess.mockResolvedValue({ allowed: true });
  mockClaimConversationInSession.mockResolvedValue('claimed');
});

describe('POST /api/agent-sessions/[sessionId]/conversations/[conversationId]/claim', () => {
  it('claims a never-bound conversation into the session', async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, alreadyInSession: false });
    expect(mockClaimConversationInSession).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      userId: AUTH_USER.userId,
      sessionId: SESSION_ID,
    });
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'data.write', details: expect.objectContaining({ op: 'claim_conversation' }) }),
    );
  });

  it('an idempotent re-claim (already_in_session) still answers 200, with no fresh data.write audit', async () => {
    mockClaimConversationInSession.mockResolvedValue('already_in_session');
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, alreadyInSession: true });
    expect(mockAuditRequest).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'data.write' }),
    );
  });

  it('404s an unknown session — same shape whether it never existed or is denied', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'session_not_found' });
    const response = await post();
    expect(response.status).toBe(404);
    expect(mockClaimConversationInSession).not.toHaveBeenCalled();
  });

  it('404s a session the requester cannot reach, but still audits the denial', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'drive_access_denied' });
    const response = await post();
    expect(response.status).toBe(404);
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'authz.access.denied' }),
    );
  });

  it('404s a conversation that is not available to claim — session access alone is not enough (H1 gate lives in the primitive)', async () => {
    mockClaimConversationInSession.mockResolvedValue('not_found');
    const response = await post();
    expect(response.status).toBe(404);
  });

  it("400s a cross-drive mismatch — the conversation's agent belongs to a different drive than this session", async () => {
    mockClaimConversationInSession.mockResolvedValue('cross_drive_denied');
    const response = await post();
    expect(response.status).toBe(400);
  });

  it('409s an ended session', async () => {
    mockClaimConversationInSession.mockResolvedValue('session_ended');
    const response = await post();
    expect(response.status).toBe(409);
  });

  it("429s a session already at MAX_SESSION_CONVERSATIONS, as a quota refusal with the shared human message", async () => {
    mockClaimConversationInSession.mockResolvedValue('session_full');
    const response = await post();
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error).toMatch(/maximum number of conversations/i);
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'security.rate.limited' }),
    );
  });

  it('500s a thrown failure with a human error', async () => {
    mockClaimConversationInSession.mockRejectedValue(new Error('db exploded'));
    const response = await post();
    expect(response.status).toBe(500);
  });

  it('given an auth failure, should return the auth error untouched', async () => {
    const error = new Response(null, { status: 401 });
    mockAuthenticateRequest.mockResolvedValue({ error });
    const response = await post();
    expect(response.status).toBe(401);
    expect(mockCheckSessionAccess).not.toHaveBeenCalled();
  });
});
