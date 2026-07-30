// @vitest-environment node
/**
 * The session-centric conversation creator. What matters here is the ACCESS
 * LAYERING: session access answers for the session, page access answers for
 * the agent page, and neither can stand in for the other — plus the assistant
 * shape (`agentPageId: null`), which is the only way an assistant thread can
 * join a session at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuthenticateRequest,
  mockAuditRequest,
  mockCheckSessionAccess,
  mockCreateConversationInSession,
  mockGetAiAgent,
  mockCanPrincipalViewPage,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockAuditRequest: vi.fn(),
  mockCheckSessionAccess: vi.fn(),
  mockCreateConversationInSession: vi.fn(),
  mockGetAiAgent: vi.fn(),
  mockCanPrincipalViewPage: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequest(...args),
  isAuthError: (result: unknown) => result != null && typeof result === 'object' && 'error' in result,
  canPrincipalViewPage: (...args: unknown[]) => mockCanPrincipalViewPage(...args),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: (...args: unknown[]) => mockAuditRequest(...args),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { error: vi.fn(), warn: vi.fn() } },
}));
vi.mock('@/lib/agent-sessions/agent-sessions-runtime', () => ({
  checkSessionAccess: (...args: unknown[]) => mockCheckSessionAccess(...args),
  createConversationInSession: (...args: unknown[]) => mockCreateConversationInSession(...args),
}));
vi.mock('@/lib/repositories/conversation-repository', () => ({
  conversationRepository: { getAiAgent: (...args: unknown[]) => mockGetAiAgent(...args) },
}));

import { POST } from '../route';

const AUTH_USER = { userId: 'user-1', role: 'admin' };
const SESSION_ID = 'ses-1';
// A real cuid2, so the client-id trust path is exercised with a value isCuid accepts.
const CLIENT_CONVERSATION_ID = 'tz4a98xxat96iws9zmbrgj3a';

const params = { params: Promise.resolve({ sessionId: SESSION_ID }) };
const post = (body?: unknown) =>
  POST(
    new Request(`http://localhost/api/agent-sessions/${SESSION_ID}/conversations`, {
      method: 'POST',
      ...(body !== undefined
        ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
        : {}),
    }),
    params,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue(AUTH_USER);
  mockCheckSessionAccess.mockResolvedValue({ allowed: true });
  mockCreateConversationInSession.mockResolvedValue(undefined);
  mockGetAiAgent.mockResolvedValue({ id: 'agent-1' });
  mockCanPrincipalViewPage.mockResolvedValue(true);
});

describe('POST /api/agent-sessions/[sessionId]/conversations', () => {
  it('creates an AGENT conversation bound to the session', async () => {
    const response = await post({ agentPageId: 'agent-1' });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(typeof body.conversationId).toBe('string');
    expect(mockCreateConversationInSession).toHaveBeenCalledWith({
      conversationId: body.conversationId,
      userId: 'user-1',
      agentPageId: 'agent-1',
      sessionId: SESSION_ID,
    });
  });

  it('creates an ASSISTANT conversation (agentPageId null) — no page checks to make', async () => {
    const response = await post({});
    expect(response.status).toBe(201);
    expect(mockCreateConversationInSession).toHaveBeenCalledWith(
      expect.objectContaining({ agentPageId: null, sessionId: SESSION_ID }),
    );
    // The assistant has no page — asking the page layer about it would be a
    // question with no subject.
    expect(mockGetAiAgent).not.toHaveBeenCalled();
    expect(mockCanPrincipalViewPage).not.toHaveBeenCalled();
  });

  it('honours a client-minted cuid2 id, and REPLACES a malformed one', async () => {
    const trusted = await post({ conversationId: CLIENT_CONVERSATION_ID });
    expect((await trusted.json()).conversationId).toBe(CLIENT_CONVERSATION_ID);

    const forged = await post({ conversationId: 'not-a-cuid; DROP TABLE' });
    const body = await forged.json();
    expect(body.conversationId).not.toBe('not-a-cuid; DROP TABLE');
  });

  it('404s an unknown session — a conversation joins a workspace, never mints one', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'session_not_found' });
    const response = await post({});
    expect(response.status).toBe(404);
    expect(mockCreateConversationInSession).not.toHaveBeenCalled();
  });

  it('403s a session the requester cannot reach, and audits it', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'drive_access_denied' });
    const response = await post({ agentPageId: 'agent-1' });
    expect(response.status).toBe(403);
    expect(mockCreateConversationInSession).not.toHaveBeenCalled();
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'authz.access.denied' }),
    );
  });

  it('session access never smuggles page access: an unviewable agent page still 403s', async () => {
    mockCanPrincipalViewPage.mockResolvedValue(false);
    const response = await post({ agentPageId: 'agent-1' });
    expect(response.status).toBe(403);
    expect(mockCreateConversationInSession).not.toHaveBeenCalled();
  });

  it('404s a page that is not an AI agent', async () => {
    mockGetAiAgent.mockResolvedValue(null);
    const response = await post({ agentPageId: 'not-an-agent' });
    expect(response.status).toBe(404);
    expect(mockCreateConversationInSession).not.toHaveBeenCalled();
  });

  it('502s a creation failure with a human error', async () => {
    mockCreateConversationInSession.mockRejectedValue(new Error('squat guard refused'));
    const response = await post({});
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Could not start a conversation' });
  });

  it('given an auth failure, should return the auth error untouched', async () => {
    const error = new Response(null, { status: 401 });
    mockAuthenticateRequest.mockResolvedValue({ error });
    const response = await post({});
    expect(response.status).toBe(401);
    expect(mockCheckSessionAccess).not.toHaveBeenCalled();
  });
});
