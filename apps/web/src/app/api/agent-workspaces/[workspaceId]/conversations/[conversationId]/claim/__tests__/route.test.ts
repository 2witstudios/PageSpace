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

const {
  mockAuthenticateRequest,
  mockAuditRequest,
  mockCheckSessionAccess,
  mockClaimConversationInSession,
  mockGetConversation,
  mockCanPrincipalViewPage,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockAuditRequest: vi.fn(),
  mockCheckSessionAccess: vi.fn(),
  mockClaimConversationInSession: vi.fn(),
  mockGetConversation: vi.fn(),
  mockCanPrincipalViewPage: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequest(...args),
  isAuthError: (result: unknown) => result != null && typeof result === 'object' && 'error' in result,
  canPrincipalViewPage: (...args: unknown[]) => mockCanPrincipalViewPage(...args),
}));
vi.mock('@/lib/repositories/conversation-repository', () => ({
  conversationRepository: { getConversation: (...args: unknown[]) => mockGetConversation(...args) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: (...args: unknown[]) => mockAuditRequest(...args),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { error: vi.fn(), warn: vi.fn() } },
}));
vi.mock('@/lib/agent-workspaces/agent-workspaces-runtime', () => ({
  checkSessionAccess: (...args: unknown[]) => mockCheckSessionAccess(...args),
  claimConversationInSession: (...args: unknown[]) => mockClaimConversationInSession(...args),
}));

import { POST } from '../route';

const AUTH_USER = { userId: 'user-1', role: 'admin' };
const SESSION_ID = 'ses-1';
const CONVERSATION_ID = 'conv-1';

const params = { params: Promise.resolve({ workspaceId: SESSION_ID, conversationId: CONVERSATION_ID }) };
const post = () =>
  POST(
    new Request(`http://localhost/api/agent-workspaces/${SESSION_ID}/conversations/${CONVERSATION_ID}/claim`, {
      method: 'POST',
    }),
    params,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue(AUTH_USER);
  mockCheckSessionAccess.mockResolvedValue({ allowed: true });
  mockClaimConversationInSession.mockResolvedValue('claimed');
  // No row (or a non-page row) by default — the permission preflight is a
  // no-op unless a test explicitly opts a `type: 'page'` row in.
  mockGetConversation.mockResolvedValue(null);
  mockCanPrincipalViewPage.mockResolvedValue(true);
});

describe('POST /api/agent-workspaces/[workspaceId]/conversations/[conversationId]/claim', () => {
  it('claims a never-bound conversation into the session', async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, alreadyInSession: false });
    expect(mockClaimConversationInSession).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      userId: AUTH_USER.userId,
      workspaceId: SESSION_ID,
    });
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'data.write', details: expect.objectContaining({ op: 'claim_conversation' }) }),
    );
  });

  it('forwards the pane the History pick was made from, as a placement preference', async () => {
    // A claim ADMITS, and admitting places — so without this the reopened
    // thread lands in whichever pane qualifies first rather than the one whose
    // History the user opened.
    const response = await POST(
      new Request(`http://localhost/api/agent-workspaces/${SESSION_ID}/conversations/${CONVERSATION_ID}/claim`, {
        method: 'POST',
        body: JSON.stringify({ activeNodeId: 'node-7' }),
      }),
      params,
    );
    expect(response.status).toBe(200);
    expect(mockClaimConversationInSession).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      userId: AUTH_USER.userId,
      workspaceId: SESSION_ID,
      activeNodeId: 'node-7',
    });
  });

  it('claims without a preference when the body carries an unusable one, rather than refusing', async () => {
    // A preference, not an instruction: this route has never required a body,
    // and an unusable one must not become the first way to fail a claim.
    const response = await POST(
      new Request(`http://localhost/api/agent-workspaces/${SESSION_ID}/conversations/${CONVERSATION_ID}/claim`, {
        method: 'POST',
        body: JSON.stringify({ activeNodeId: 42 }),
      }),
      params,
    );
    expect(response.status).toBe(200);
    expect(mockClaimConversationInSession).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      userId: AUTH_USER.userId,
      workspaceId: SESSION_ID,
    });
  });

  it("403s + audits when the caller can no longer view a page conversation's agent — owning the conversation is not permission to use the agent (review finding — chatgpt-codex-connector)", async () => {
    mockGetConversation.mockResolvedValue({
      userId: AUTH_USER.userId,
      type: 'page',
      contextId: 'agent-1',
      workspaceId: null,
      isActive: true,
    });
    mockCanPrincipalViewPage.mockResolvedValue(false);
    const response = await post();
    expect(response.status).toBe(403);
    expect(mockClaimConversationInSession).not.toHaveBeenCalled();
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'authz.access.denied', resourceId: 'agent-1' }),
    );
  });

  it('claims a page conversation when the caller can still view its agent', async () => {
    mockGetConversation.mockResolvedValue({
      userId: AUTH_USER.userId,
      type: 'page',
      contextId: 'agent-1',
      workspaceId: null,
      isActive: true,
    });
    mockCanPrincipalViewPage.mockResolvedValue(true);
    const response = await post();
    expect(response.status).toBe(200);
    expect(mockCanPrincipalViewPage).toHaveBeenCalledWith(AUTH_USER, 'agent-1');
    expect(mockClaimConversationInSession).toHaveBeenCalled();
  });

  it('skips the page-permission check entirely for a global conversation — no agent to view', async () => {
    mockGetConversation.mockResolvedValue({
      userId: AUTH_USER.userId,
      type: 'global',
      contextId: null,
      workspaceId: null,
      isActive: true,
    });
    const response = await post();
    expect(response.status).toBe(200);
    expect(mockCanPrincipalViewPage).not.toHaveBeenCalled();
  });

  it("skips the page-permission check for a conversation the caller doesn't own — the claim call's own H1 gate refuses it instead, not a permission 403", async () => {
    mockGetConversation.mockResolvedValue({
      userId: 'someone-else',
      type: 'page',
      contextId: 'agent-1',
      workspaceId: null,
      isActive: true,
    });
    mockClaimConversationInSession.mockResolvedValue('not_found');
    const response = await post();
    expect(response.status).toBe(404);
    expect(mockCanPrincipalViewPage).not.toHaveBeenCalled();
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
    mockClaimConversationInSession.mockResolvedValue('awaiting_backfill');
    const response = await post();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'awaiting_backfill' });
  });
});
