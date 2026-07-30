// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuthenticateRequest,
  mockAuditRequest,
  mockListSessions,
  mockListShellsBulk,
  mockListSessionConversationsBulk,
  mockCountActiveSessionsForOwner,
  mockCheckAccessForSubject,
  mockCreateConversationInSession,
  mockEndSession,
  mockSpawnSession,
  mockGetAiAgent,
  mockCanPrincipalViewPage,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockAuditRequest: vi.fn(),
  mockListSessions: vi.fn(),
  mockListShellsBulk: vi.fn(),
  mockListSessionConversationsBulk: vi.fn(),
  mockCountActiveSessionsForOwner: vi.fn(),
  mockCheckAccessForSubject: vi.fn(),
  mockCreateConversationInSession: vi.fn(),
  mockEndSession: vi.fn(),
  mockSpawnSession: vi.fn(),
  mockGetAiAgent: vi.fn(),
  mockCanPrincipalViewPage: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequest(...args),
  isAuthError: (result: unknown) => result != null && typeof result === 'object' && 'error' in result,
  canPrincipalViewPage: (...args: unknown[]) => mockCanPrincipalViewPage(...args),
}));
vi.mock('@/lib/repositories/conversation-repository', () => ({
  conversationRepository: { getAiAgent: (...args: unknown[]) => mockGetAiAgent(...args) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: (...args: unknown[]) => mockAuditRequest(...args),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { error: vi.fn(), warn: vi.fn() } },
}));
vi.mock('@/lib/agent-sessions/agent-sessions-runtime', () => ({
  listSessions: (...args: unknown[]) => mockListSessions(...args),
  listSessionConversationsBulk: (...args: unknown[]) => mockListSessionConversationsBulk(...args),
  countActiveSessionsForOwner: (...args: unknown[]) => mockCountActiveSessionsForOwner(...args),
  checkAccessForSubject: (...args: unknown[]) => mockCheckAccessForSubject(...args),
  createConversationInSession: (...args: unknown[]) => mockCreateConversationInSession(...args),
  endSession: (...args: unknown[]) => mockEndSession(...args),
  spawnSession: (...args: unknown[]) => mockSpawnSession(...args),
  toAgentSessionDTO: (row: { id: string }) => ({ sessionId: row.id, dto: true }),
}));
vi.mock('@/lib/agent-sessions/session-shells-runtime', () => ({
  listShellsBulk: (...args: unknown[]) => mockListShellsBulk(...args),
}));

import { GET, POST } from '../route';

const AUTH_ADMIN = { userId: 'user-1', role: 'admin' };
const AUTH_NON_ADMIN = { userId: 'user-2', role: 'user' };

const SESSION_DTO = {
  sessionId: 'ses-1',
  driveId: 'drive-1',
  ownerId: 'user-1',
  name: 'worker',
  sandboxStatus: 'running',
  createdAt: '2026-07-28T00:00:00.000Z',
  lastActiveAt: null,
  endedAt: null,
};

const SHELL_DTO = {
  shellId: 'shell-row-1',
  sessionId: 'ses-1',
  ownerId: 'user-1',
  name: 'shell-1',
  agentType: 'shell',
  command: null,
  createdAt: '2026-07-28T00:00:00.000Z',
};

const CONVERSATION_ENTRY = {
  conversationId: 'conv-1',
  title: 'First chat',
  agentPageId: 'agent-1',
  lastMessageAt: '2026-07-28T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue(AUTH_ADMIN);
  mockListSessions.mockResolvedValue([SESSION_DTO]);
  mockListShellsBulk.mockResolvedValue(new Map([['ses-1', [SHELL_DTO]]]));
  mockListSessionConversationsBulk.mockResolvedValue(new Map([['ses-1', [CONVERSATION_ENTRY]]]));
  mockCountActiveSessionsForOwner.mockResolvedValue(0);
});

describe('GET /api/agent-sessions', () => {
  it('given an admin with no filter, should list THEIR sessions with shells AND conversations attached', async () => {
    const response = await GET(new Request('http://localhost/api/agent-sessions'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sessions: [{ ...SESSION_DTO, shells: [SHELL_DTO], conversations: [CONVERSATION_ENTRY] }],
    });
    expect(mockListSessions).toHaveBeenCalledWith({ ownerId: 'user-1' });
    // ONE bulk call each, however many sessions — the poll must not be 1+2N.
    expect(mockListSessionConversationsBulk).toHaveBeenCalledTimes(1);
    expect(mockListSessionConversationsBulk).toHaveBeenCalledWith(['ses-1']);
    expect(mockListShellsBulk).toHaveBeenCalledWith(['ses-1']);
  });

  it('given ?driveId=, should narrow WHERE but never WHOSE (ownerId still rides the filter)', async () => {
    await GET(new Request('http://localhost/api/agent-sessions?driveId=drive-1'));
    expect(mockListSessions).toHaveBeenCalledWith({ driveId: 'drive-1', ownerId: 'user-1' });
  });

  it('given ?agentId=, should IGNORE it — a session hosts many agents, so no such filter exists', async () => {
    await GET(new Request('http://localhost/api/agent-sessions?agentId=page-1'));
    expect(mockListSessions).toHaveBeenCalledWith({ ownerId: 'user-1' });
  });

  it('given a non-admin, should 403 WITHOUT enumerating anything, and audit the denial', async () => {
    mockAuthenticateRequest.mockResolvedValue(AUTH_NON_ADMIN);
    const response = await GET(new Request('http://localhost/api/agent-sessions'));
    expect(response.status).toBe(403);
    expect(mockListSessions).not.toHaveBeenCalled();
    expect(mockListShellsBulk).not.toHaveBeenCalled();
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'authz.access.denied' }),
    );
  });

  it('given an auth failure, should return the auth error untouched', async () => {
    const error = new Response(null, { status: 401 });
    mockAuthenticateRequest.mockResolvedValue({ error });
    const response = await GET(new Request('http://localhost/api/agent-sessions'));
    expect(response.status).toBe(401);
    expect(mockListSessions).not.toHaveBeenCalled();
  });

  it('given a listing failure, should 500 with a human error', async () => {
    mockListSessions.mockRejectedValue(new Error('db down'));
    const response = await GET(new Request('http://localhost/api/agent-sessions'));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to list agent sessions' });
  });
});


describe('POST /api/agent-sessions — spawn', () => {
  const spawn = (body: unknown) =>
    POST(
      new Request('http://localhost/api/agent-sessions', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
    );

  beforeEach(() => {
    mockCheckAccessForSubject.mockResolvedValue({ allowed: true });
    mockSpawnSession.mockResolvedValue({ ok: true, session: { id: 'ses-new' } });
    mockCreateConversationInSession.mockResolvedValue(undefined);
    mockEndSession.mockResolvedValue({ ok: true, spriteTornDown: false });
    mockGetAiAgent.mockResolvedValue({ id: 'agent-1', title: 'Agent', type: 'AI_CHAT', driveId: 'drive-1' });
    mockCanPrincipalViewPage.mockResolvedValue(true);
    mockCountActiveSessionsForOwner.mockResolvedValue(0);
  });

  it('spawns ONE session with ONE bound conversation — and NO sandbox', async () => {
    const response = await spawn({ driveId: 'drive-1', agentPageId: 'agent-1', name: 'api refactor' });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.session).toEqual({ sessionId: 'ses-new', dto: true });
    expect(typeof body.conversationId).toBe('string');
    expect(mockSpawnSession).toHaveBeenCalledWith({ userId: 'user-1', driveId: 'drive-1', name: 'api refactor' });
    expect(mockCreateConversationInSession).toHaveBeenCalledWith(
      expect.objectContaining({ agentPageId: 'agent-1', sessionId: 'ses-new', userId: 'user-1' }),
    );
    // Spawn is instant and free: nothing here may provision. There is no
    // provision mock to assert against because the route does not import one —
    // the absence is structural.
  });

  it('spawns a GLOBAL-ASSISTANT session from the both-null shape', async () => {
    const response = await spawn({});
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(typeof body.conversationId).toBe('string');
    expect(mockSpawnSession).toHaveBeenCalledWith({ userId: 'user-1', driveId: null, name: null });
    // The first conversation is an assistant thread: no agent page.
    expect(mockCreateConversationInSession).toHaveBeenCalledWith(
      expect.objectContaining({ agentPageId: null, sessionId: 'ses-new' }),
    );
    // And the access decision saw the global subject (driveId null → owner-only).
    expect(mockCheckAccessForSubject).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ driveId: null }),
    );
  });

  it('refuses the half-specified shapes — an agent needs its drive, a drive needs an agent', async () => {
    for (const body of [{ driveId: 'drive-1' }, { agentPageId: 'agent-1' }]) {
      const response = await spawn(body);
      expect(response.status).toBe(400);
    }
    expect(mockSpawnSession).not.toHaveBeenCalled();
  });

  it('gates on the shared access decision BEFORE minting anything', async () => {
    mockCheckAccessForSubject.mockResolvedValue({ allowed: false, reason: 'drive_access_denied' });
    const response = await spawn({ driveId: 'drive-1', agentPageId: 'agent-1' });
    expect(response.status).toBe(403);
    expect(mockSpawnSession).not.toHaveBeenCalled();
  });

  it('given the first conversation fails, ENDS the just-minted session — no empty workspace exists', async () => {
    mockCreateConversationInSession.mockRejectedValue(new Error('squat guard refused'));
    const response = await spawn({ driveId: 'drive-1', agentPageId: 'agent-1' });
    expect(response.status).toBe(502);
    expect(mockEndSession).toHaveBeenCalledWith('ses-new');
  });
});

describe('POST /api/agent-sessions — spawn agent validation (review M6)', () => {
  const spawn = (body: unknown) =>
    POST(
      new Request('http://localhost/api/agent-sessions', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
    );

  beforeEach(() => {
    mockCheckAccessForSubject.mockResolvedValue({ allowed: true });
    mockSpawnSession.mockResolvedValue({ ok: true, session: { id: 'ses-new' } });
    mockCreateConversationInSession.mockResolvedValue(undefined);
    mockGetAiAgent.mockResolvedValue({ id: 'agent-1', title: 'Agent', type: 'AI_CHAT', driveId: 'drive-1' });
    mockCanPrincipalViewPage.mockResolvedValue(true);
    mockCountActiveSessionsForOwner.mockResolvedValue(0);
  });

  it('404s an unknown/non-agent page BEFORE minting anything', async () => {
    mockGetAiAgent.mockResolvedValue(null);
    const response = await spawn({ driveId: 'drive-1', agentPageId: 'ghost' });
    expect(response.status).toBe(404);
    expect(mockSpawnSession).not.toHaveBeenCalled();
  });

  it("400s an agent from a DIFFERENT drive — a session hosts only its own drive's agents", async () => {
    mockGetAiAgent.mockResolvedValue({ id: 'agent-1', title: 'Agent', type: 'AI_CHAT', driveId: 'drive-other' });
    const response = await spawn({ driveId: 'drive-1', agentPageId: 'agent-1' });
    expect(response.status).toBe(400);
    expect(mockSpawnSession).not.toHaveBeenCalled();
  });

  it('403s an agent the requester cannot view, and audits it', async () => {
    mockCanPrincipalViewPage.mockResolvedValue(false);
    const response = await spawn({ driveId: 'drive-1', agentPageId: 'agent-1' });
    expect(response.status).toBe(403);
    expect(mockSpawnSession).not.toHaveBeenCalled();
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'authz.access.denied' }),
    );
  });

  it('caps the stored name — a label rendered everywhere must stay bounded', async () => {
    const response = await spawn({ driveId: 'drive-1', agentPageId: 'agent-1', name: 'x'.repeat(500) });
    expect(response.status).toBe(201);
    expect(mockSpawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'x'.repeat(120) }),
    );
  });
});

describe('POST /api/agent-sessions — spawn ceiling (review M6/F4)', () => {
  const spawn = (body: unknown) =>
    POST(
      new Request('http://localhost/api/agent-sessions', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
    );

  it('429s at the active-session ceiling — spawn is free, but not unbounded', async () => {
    mockCheckAccessForSubject.mockResolvedValue({ allowed: true });
    mockGetAiAgent.mockResolvedValue({ id: 'agent-1', title: 'Agent', type: 'AI_CHAT', driveId: 'drive-1' });
    mockCanPrincipalViewPage.mockResolvedValue(true);
    mockCountActiveSessionsForOwner.mockResolvedValue(100);
    const response = await spawn({ driveId: 'drive-1', agentPageId: 'agent-1' });
    expect(response.status).toBe(429);
    expect(mockSpawnSession).not.toHaveBeenCalled();
  });
});
