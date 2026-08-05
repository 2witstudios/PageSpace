import { describe, test, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// Tests for session-tools-runtime.ts — resolveCallerSessionForWorker
//
// A worker works in its SPAWNER's workspace. PERMISSION gates minting;
// workspace lifecycle state never does (issue #2335 product decision —
// orchestration works from any surface):
//  - a bound session is used AS IS, even if ended (the claim reopens it);
//  - an unbound GLOBAL conversation mints with the user's own authority;
//  - an unbound PAGE conversation mints in its agent's drive, gated by the
//    same primitives the manual "New session" route enforces.
// ============================================================================

const {
  mockFindSessionForConversation,
  mockEnsureGlobalSandboxSession,
  mockEnsureDriveSessionForConversation,
  mockCheckAccessForSubject,
  mockCanUserViewPage,
  mockGetConversation,
  mockGetAiAgent,
} = vi.hoisted(() => ({
  mockFindSessionForConversation: vi.fn(),
  mockEnsureGlobalSandboxSession: vi.fn(),
  mockEnsureDriveSessionForConversation: vi.fn(),
  mockCheckAccessForSubject: vi.fn(),
  mockCanUserViewPage: vi.fn(),
  mockGetConversation: vi.fn(),
  mockGetAiAgent: vi.fn(),
}));

vi.mock('@/lib/agent-sessions/agent-sessions-runtime', () => ({
  findSessionForConversation: mockFindSessionForConversation,
  ensureGlobalSandboxSession: mockEnsureGlobalSandboxSession,
  ensureDriveSessionForConversation: mockEnsureDriveSessionForConversation,
  checkAccessForSubject: mockCheckAccessForSubject,
  createConversationInSession: vi.fn(),
  provisionSessionSandbox: vi.fn(),
  getAgentSessionStore: vi.fn(),
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserViewPage: mockCanUserViewPage,
}));
vi.mock('@/lib/repositories/conversation-repository', () => ({
  conversationRepository: { getConversation: mockGetConversation, getAiAgent: mockGetAiAgent },
}));
vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('@/lib/agent-sessions/session-shells-runtime', () => ({
  getSessionShellStore: vi.fn(),
  killShellById: vi.fn(),
  listShells: vi.fn(),
  spawnShell: vi.fn(),
}));
vi.mock('@/lib/ai/core/abort-conversation-streams', () => ({
  abortConversationStreams: vi.fn(),
}));
vi.mock('../shell-io', () => ({
  createShellIo: vi.fn(),
  realtimeShellIoTransport: {},
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

import { resolveCallerSessionForWorker } from '../session-tools-runtime';

const sessionRow = { id: 'ses-1', ownerId: 'user-1', endedAt: null };
const globalConversation = { id: 'conv-g', type: 'global', userId: 'user-1', isActive: true, contextId: null };
const pageConversation = { id: 'conv-p', type: 'page', userId: 'user-1', isActive: true, contextId: 'agent-1' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveCallerSessionForWorker', () => {
  test('a conversation already bound to a session resolves it directly — no auto-bind attempted', async () => {
    mockFindSessionForConversation.mockResolvedValue(sessionRow);

    const resolved = await resolveCallerSessionForWorker('conv-1', 'user-1');

    expect(resolved).toEqual({ ok: true, session: sessionRow });
    expect(mockGetConversation).not.toHaveBeenCalled();
    expect(mockEnsureGlobalSandboxSession).not.toHaveBeenCalled();
  });

  test('a conversation bound to an ENDED session still resolves it — lifecycle state never gates orchestration; the worker claim reopens the listing (issue #2335)', async () => {
    const ended = { ...sessionRow, endedAt: new Date() };
    mockFindSessionForConversation.mockResolvedValue(ended);

    const resolved = await resolveCallerSessionForWorker('conv-1', 'user-1');

    expect(resolved).toEqual({ ok: true, session: ended });
    expect(mockEnsureGlobalSandboxSession).not.toHaveBeenCalled();
  });

  test('an unbound GLOBAL conversation mints and binds a session via the shared spawn+claim primitive', async () => {
    mockFindSessionForConversation.mockResolvedValue(null);
    mockGetConversation.mockResolvedValue(globalConversation);
    mockEnsureGlobalSandboxSession.mockResolvedValue({ ok: true, session: sessionRow });

    const resolved = await resolveCallerSessionForWorker('conv-g', 'user-1');

    expect(resolved).toEqual({ ok: true, session: sessionRow });
    expect(mockEnsureGlobalSandboxSession).toHaveBeenCalledWith('conv-g', 'user-1');
  });

  test('an unbound PAGE conversation mints a session in ITS AGENT\'S drive when the caller passes the agent view check and the drive access check', async () => {
    mockFindSessionForConversation.mockResolvedValue(null);
    mockGetConversation.mockResolvedValue(pageConversation);
    mockGetAiAgent.mockResolvedValue({ id: 'agent-1', driveId: 'drive-1', title: 'Agent', type: 'AI_CHAT' });
    mockCanUserViewPage.mockResolvedValue(true);
    mockCheckAccessForSubject.mockResolvedValue({ allowed: true });
    mockEnsureDriveSessionForConversation.mockResolvedValue({ ok: true, session: sessionRow });

    const resolved = await resolveCallerSessionForWorker('conv-p', 'user-1');

    expect(resolved).toEqual({ ok: true, session: sessionRow });
    expect(mockCheckAccessForSubject).toHaveBeenCalledWith('user-1', {
      sessionId: 'about-to-be-minted',
      ownerId: 'user-1',
      driveId: 'drive-1',
    });
    expect(mockEnsureDriveSessionForConversation).toHaveBeenCalledWith('conv-p', 'user-1', 'drive-1');
  });

  test('a PAGE conversation whose agent the caller cannot view refuses with not_permitted — RBAC is the gate, not binding state', async () => {
    mockFindSessionForConversation.mockResolvedValue(null);
    mockGetConversation.mockResolvedValue(pageConversation);
    mockGetAiAgent.mockResolvedValue({ id: 'agent-1', driveId: 'drive-1', title: 'Agent', type: 'AI_CHAT' });
    mockCanUserViewPage.mockResolvedValue(false);

    const resolved = await resolveCallerSessionForWorker('conv-p', 'user-1');

    expect(resolved).toEqual({ ok: false, reason: 'not_permitted' });
    expect(mockEnsureDriveSessionForConversation).not.toHaveBeenCalled();
  });

  test('a PAGE conversation whose drive refuses the spawn (checkAccessForSubject) refuses with not_permitted', async () => {
    mockFindSessionForConversation.mockResolvedValue(null);
    mockGetConversation.mockResolvedValue(pageConversation);
    mockGetAiAgent.mockResolvedValue({ id: 'agent-1', driveId: 'drive-1', title: 'Agent', type: 'AI_CHAT' });
    mockCanUserViewPage.mockResolvedValue(true);
    mockCheckAccessForSubject.mockResolvedValue({ allowed: false, reason: 'not_a_member' });

    const resolved = await resolveCallerSessionForWorker('conv-p', 'user-1');

    expect(resolved).toEqual({ ok: false, reason: 'not_permitted' });
    expect(mockEnsureDriveSessionForConversation).not.toHaveBeenCalled();
  });

  test('a foreign or history-deleted conversation refuses with no_session — the H1 ownership gate holds before any mint', async () => {
    mockFindSessionForConversation.mockResolvedValue(null);
    mockGetConversation.mockResolvedValue({ ...globalConversation, userId: 'someone-else' });

    const resolved = await resolveCallerSessionForWorker('conv-g', 'user-1');

    expect(resolved).toEqual({ ok: false, reason: 'no_session' });
    expect(mockEnsureGlobalSandboxSession).not.toHaveBeenCalled();
  });

  test('a client (API-managed) conversation keeps the truthful no_session refusal', async () => {
    mockFindSessionForConversation.mockResolvedValue(null);
    mockGetConversation.mockResolvedValue({ id: 'conv-c', type: 'client', userId: 'user-1', isActive: true, contextId: null });

    const resolved = await resolveCallerSessionForWorker('conv-c', 'user-1');

    expect(resolved).toEqual({ ok: false, reason: 'no_session' });
    expect(mockEnsureGlobalSandboxSession).not.toHaveBeenCalled();
  });

  test('a session-cap refusal surfaces as session_limit_reached, not a generic no_session', async () => {
    mockFindSessionForConversation.mockResolvedValue(null);
    mockGetConversation.mockResolvedValue(globalConversation);
    mockEnsureGlobalSandboxSession.mockResolvedValue({ ok: false, reason: 'session_limit_reached' });

    const resolved = await resolveCallerSessionForWorker('conv-g', 'user-1');

    expect(resolved).toEqual({ ok: false, reason: 'session_limit_reached' });
  });

  test('a transient spawn failure degrades to no_session — the caller retries a fresh spawn later', async () => {
    mockFindSessionForConversation.mockResolvedValue(null);
    mockGetConversation.mockResolvedValue(globalConversation);
    mockEnsureGlobalSandboxSession.mockResolvedValue({ ok: false, reason: 'spawn_failed' });

    const resolved = await resolveCallerSessionForWorker('conv-g', 'user-1');

    expect(resolved).toEqual({ ok: false, reason: 'no_session' });
  });
});
