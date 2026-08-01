// @vitest-environment node
/**
 * The session-scoped conversation-reopen route — the undo of the sibling
 * `[conversationId]` route's DELETE. What matters here: the uniform 404 for
 * an unreachable session AND for a conversation this session does not own
 * (or was history-deleted), the 429 + human message on the cap, and that an
 * idempotent re-reopen (already_open) still answers 200 without a fresh
 * audit write — mirrors `[conversationId]/__tests__/route.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAuthenticateRequest, mockAuditRequest, mockCheckSessionAccess, mockReopenConversationInSession } =
  vi.hoisted(() => ({
    mockAuthenticateRequest: vi.fn(),
    mockAuditRequest: vi.fn(),
    mockCheckSessionAccess: vi.fn(),
    mockReopenConversationInSession: vi.fn(),
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
  reopenConversationInSession: (...args: unknown[]) => mockReopenConversationInSession(...args),
}));

import { POST } from '../route';

const AUTH_USER = { userId: 'user-1', role: 'admin' };
const SESSION_ID = 'ses-1';
const CONVERSATION_ID = 'conv-1';

const params = { params: Promise.resolve({ sessionId: SESSION_ID, conversationId: CONVERSATION_ID }) };
const post = () =>
  POST(
    new Request(`http://localhost/api/agent-sessions/${SESSION_ID}/conversations/${CONVERSATION_ID}/reopen`, {
      method: 'POST',
    }),
    params,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue(AUTH_USER);
  mockCheckSessionAccess.mockResolvedValue({ allowed: true });
  mockReopenConversationInSession.mockResolvedValue('reopened');
});

describe('POST /api/agent-sessions/[sessionId]/conversations/[conversationId]/reopen', () => {
  it('reopens a closed listing', async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, alreadyOpen: false });
    expect(mockReopenConversationInSession).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      sessionId: SESSION_ID,
    });
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'data.write', details: expect.objectContaining({ op: 'reopen_conversation' }) }),
    );
  });

  it('an idempotent re-reopen (already_open) still answers 200, with no fresh data.write audit', async () => {
    mockReopenConversationInSession.mockResolvedValue('already_open');
    const response = await post();
    expect(response.status).toBe(200);
    // Distinguishes a no-op from a genuine transition — a caller that races
    // this response with a supersession must know whether it's safe to roll
    // the listing back out (review finding — chatgpt-codex-connector on
    // PR #2299, round 15).
    expect(await response.json()).toEqual({ ok: true, alreadyOpen: true });
    expect(mockAuditRequest).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'data.write' }),
    );
  });

  it('404s an unknown session — same shape whether it never existed or is denied', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'session_not_found' });
    const response = await post();
    expect(response.status).toBe(404);
    expect(mockReopenConversationInSession).not.toHaveBeenCalled();
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

  it('404s a conversation this session does not own (not_in_session) — session access alone is not enough', async () => {
    mockReopenConversationInSession.mockResolvedValue('not_in_session');
    const response = await post();
    expect(response.status).toBe(404);
  });

  it('404s a history-deleted conversation — nothing left to restore, same shape as not-found', async () => {
    mockReopenConversationInSession.mockResolvedValue('history_deleted');
    const response = await post();
    expect(response.status).toBe(404);
  });

  it("429s a session already at MAX_SESSION_CONVERSATIONS, as a quota refusal with the shared human message", async () => {
    mockReopenConversationInSession.mockResolvedValue('session_full');
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
    mockReopenConversationInSession.mockRejectedValue(new Error('db exploded'));
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
