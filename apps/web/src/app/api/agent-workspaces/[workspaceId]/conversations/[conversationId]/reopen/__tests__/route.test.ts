// @vitest-environment node
/**
 * The session-scoped conversation-reopen route — the undo of the sibling
 * `[conversationId]` route's DELETE. What matters here: the uniform 404 for
 * an unreachable session AND for a conversation this session does not own
 * (or was history-deleted), the 409 + human message when the workspace is full
 * — reopening is a re-admission and consumes a cap slot — and that an
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
vi.mock('@/lib/agent-workspaces/agent-workspaces-runtime', () => ({
  checkSessionAccess: (...args: unknown[]) => mockCheckSessionAccess(...args),
  reopenConversationInSession: (...args: unknown[]) => mockReopenConversationInSession(...args),
}));

import { POST } from '../route';

const AUTH_USER = { userId: 'user-1', role: 'admin' };
const SESSION_ID = 'ses-1';
const CONVERSATION_ID = 'conv-1';

const params = { params: Promise.resolve({ workspaceId: SESSION_ID, conversationId: CONVERSATION_ID }) };
const post = () =>
  POST(
    new Request(`http://localhost/api/agent-workspaces/${SESSION_ID}/conversations/${CONVERSATION_ID}/reopen`, {
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

describe('POST /api/agent-workspaces/[workspaceId]/conversations/[conversationId]/reopen', () => {
  it('reopens a closed listing', async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, alreadyOpen: false });
    // The CALLER's id travels with the request — see the close route's twin
    // assertion. Session access is not conversation ownership, and only the
    // primitive can enforce the second, so the route has to pass the caller.
    expect(mockReopenConversationInSession).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      userId: AUTH_USER.userId,
      workspaceId: SESSION_ID,
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

  it('409s a workspace at MAX_SESSION_CONVERSATIONS — a return is an ADMISSION and can lose the last slot', async () => {
    // Closing DESTROYS the node, so a closed thread is a member of nothing and
    // coming back re-consults the cap like any other admission. 409 rather than
    // the "nothing here" 404 the other refusals take: the thread exists, it is
    // the caller's, and closing something else fixes it — the one refusal on
    // this path a user can act on.
    mockReopenConversationInSession.mockResolvedValue('session_full');
    const response = await post();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('full') });
    // A refusal is not a write.
    expect(mockAuditRequest).not.toHaveBeenCalled();
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

describe('the workspace is waiting for the backfill', () => {
  /**
   * 503, not 404 and not 200. The conversation exists and is the caller's; the
   * SERVER has not migrated this workspace yet, and it becomes ready when an
   * operator runs the backfill — which is what 503 says and what nothing else on
   * this route does.
   *
   * The status is asserted rather than assumed because this route has no
   * exhaustiveness check: an adversarial review found that deleting the 503
   * block lets the request fall through to `200 OK`, reporting success for a
   * write the server refused.
   */
  it('answers 503 and names the reason', async () => {
    mockReopenConversationInSession.mockResolvedValue('awaiting_backfill');
    const response = await post();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'awaiting_backfill' });
  });
});
