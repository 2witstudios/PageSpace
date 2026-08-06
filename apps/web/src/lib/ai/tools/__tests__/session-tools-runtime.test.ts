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
  mockCheckSessionAccess,
  mockCreateConversationInSession,
  mockSpawnSession,
  mockEndSession,
  mockListSessions,
  mockListSessionConversationsBulk,
  mockCanUserViewPage,
  mockGetConversation,
  mockGetAiAgent,
} = vi.hoisted(() => ({
  mockFindSessionForConversation: vi.fn(),
  mockEnsureGlobalSandboxSession: vi.fn(),
  mockEnsureDriveSessionForConversation: vi.fn(),
  mockCheckAccessForSubject: vi.fn(),
  mockCheckSessionAccess: vi.fn(),
  mockCreateConversationInSession: vi.fn(),
  mockSpawnSession: vi.fn(),
  mockEndSession: vi.fn(),
  mockListSessions: vi.fn(),
  mockListSessionConversationsBulk: vi.fn(),
  mockCanUserViewPage: vi.fn(),
  mockGetConversation: vi.fn(),
  mockGetAiAgent: vi.fn(),
}));

vi.mock('@/lib/agent-sessions/agent-sessions-runtime', () => ({
  findSessionForConversation: mockFindSessionForConversation,
  ensureGlobalSandboxSession: mockEnsureGlobalSandboxSession,
  ensureDriveSessionForConversation: mockEnsureDriveSessionForConversation,
  checkAccessForSubject: mockCheckAccessForSubject,
  checkSessionAccess: mockCheckSessionAccess,
  createConversationInSession: mockCreateConversationInSession,
  spawnSession: mockSpawnSession,
  endSession: mockEndSession,
  listSessions: mockListSessions,
  listSessionConversationsBulk: mockListSessionConversationsBulk,
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

import { resolveCallerSessionForWorker, buildSessionToolsDeps } from '../session-tools-runtime';

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

// ============================================================================
// Tests for session-tools-runtime.ts — createWorkerSession's placement logic
//
// The dep spawn_session calls. Placement is permission-gated, never
// binding-state-gated: omitted = the caller's own workspace, 'new' = a
// freshly minted ISOLATED workspace, anything else = an existing workspaceId
// the caller may use.
// ============================================================================

describe('createWorkerSession — placement', () => {
  const baseInput = {
    conversationId: 'worker-conv-new',
    callerConversationId: 'conv-caller',
    ownerId: 'user-1',
    agentPageId: null as string | null,
    name: 'worker',
  };

  test('workspace omitted: resolves the caller\'s own session and creates the worker there', async () => {
    mockFindSessionForConversation.mockResolvedValue({ id: 'ses-caller', ownerId: 'user-1', endedAt: null });
    mockCreateConversationInSession.mockResolvedValue(undefined);

    const deps = buildSessionToolsDeps();
    const result = await deps.createWorkerSession(baseInput);

    expect(result).toEqual({ ok: true, workspaceId: 'ses-caller' });
    expect(mockCreateConversationInSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ses-caller', conversationId: 'worker-conv-new' }),
    );
    expect(mockSpawnSession).not.toHaveBeenCalled();
    expect(mockCheckSessionAccess).not.toHaveBeenCalled();
  });

  describe('workspace: "new"', () => {
    test('mints an isolated workspace and creates the worker in it', async () => {
      mockCheckAccessForSubject.mockResolvedValue({ allowed: true });
      mockSpawnSession.mockResolvedValue({ ok: true, session: { id: 'ses-fresh' } });
      mockCreateConversationInSession.mockResolvedValue(undefined);

      const deps = buildSessionToolsDeps();
      const result = await deps.createWorkerSession({ ...baseInput, workspace: 'new' });

      expect(result).toEqual({ ok: true, workspaceId: 'ses-fresh' });
      expect(mockSpawnSession).toHaveBeenCalledWith({ userId: 'user-1', driveId: null });
      expect(mockCreateConversationInSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'ses-fresh' }),
      );
      expect(mockEndSession).not.toHaveBeenCalled();
    });

    test('derives the drive from the target agent when spawning for a page agent, and denies without checking spawnSession if the drive refuses', async () => {
      mockGetAiAgent.mockResolvedValue({ id: 'agent-1', driveId: 'drive-1' });
      mockCheckAccessForSubject.mockResolvedValue({ allowed: false, reason: 'drive_access_denied' });

      const deps = buildSessionToolsDeps();
      const result = await deps.createWorkerSession({ ...baseInput, agentPageId: 'agent-1', workspace: 'new' });

      expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'not_permitted' }));
      expect(mockCheckAccessForSubject).toHaveBeenCalledWith('user-1', expect.objectContaining({ driveId: 'drive-1' }));
      expect(mockSpawnSession).not.toHaveBeenCalled();
    });

    test('a spawnSession cap refusal propagates as session_limit_reached', async () => {
      mockCheckAccessForSubject.mockResolvedValue({ allowed: true });
      mockSpawnSession.mockResolvedValue({ ok: false, reason: 'session_limit_reached' });

      const deps = buildSessionToolsDeps();
      const result = await deps.createWorkerSession({ ...baseInput, workspace: 'new' });

      expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'session_limit_reached' }));
      expect(mockCreateConversationInSession).not.toHaveBeenCalled();
    });

    test('a create failure on a genuinely UNBOUND fresh worker unwinds the freshly minted workspace', async () => {
      mockCheckAccessForSubject.mockResolvedValue({ allowed: true });
      mockSpawnSession.mockResolvedValue({ ok: true, session: { id: 'ses-fresh' } });
      mockCreateConversationInSession.mockRejectedValue(new Error('conversation_unavailable'));
      // Re-verification finds the worker genuinely never got bound.
      mockFindSessionForConversation.mockResolvedValue(null);
      mockEndSession.mockResolvedValue(undefined);

      const deps = buildSessionToolsDeps();
      const result = await deps.createWorkerSession({ ...baseInput, workspace: 'new' });

      expect(result).toEqual(expect.objectContaining({ ok: false }));
      expect(mockEndSession).toHaveBeenCalledWith('ses-fresh');
    });

    test('AMBIGUOUS THROW: the claim actually committed despite the thrown error — reports SUCCESS and never unwinds the workspace the worker is genuinely bound to', async () => {
      // The exact hazard this regression-tests: createConversationInSession
      // throws (e.g. a dropped connection after the guarded UPDATE already
      // committed server-side), but the worker IS bound to the freshly
      // minted workspace. Unwinding blind here would orphan a live worker
      // on a session this call itself just killed, unreachable forever.
      mockCheckAccessForSubject.mockResolvedValue({ allowed: true });
      mockSpawnSession.mockResolvedValue({ ok: true, session: { id: 'ses-fresh' } });
      mockCreateConversationInSession.mockRejectedValue(new Error('connection reset'));
      mockFindSessionForConversation.mockResolvedValue({ id: 'ses-fresh', ownerId: 'user-1', endedAt: null });

      const deps = buildSessionToolsDeps();
      const result = await deps.createWorkerSession({ ...baseInput, workspace: 'new' });

      expect(result).toEqual({ ok: true, workspaceId: 'ses-fresh' });
      expect(mockEndSession).not.toHaveBeenCalled();
    });

    test('re-verification itself fails: the workspace is left alone rather than gambled on, and the original failure is still reported', async () => {
      mockCheckAccessForSubject.mockResolvedValue({ allowed: true });
      mockSpawnSession.mockResolvedValue({ ok: true, session: { id: 'ses-fresh' } });
      mockCreateConversationInSession.mockRejectedValue(new Error('connection reset'));
      mockFindSessionForConversation.mockRejectedValue(new Error('DB unreachable'));

      const deps = buildSessionToolsDeps();
      const result = await deps.createWorkerSession({ ...baseInput, workspace: 'new' });

      expect(result).toEqual(expect.objectContaining({ ok: false }));
      expect(mockEndSession).not.toHaveBeenCalled();
    });
  });

  describe('workspace: an explicit workspaceId', () => {
    test('creates the worker directly in the named workspace when the caller may use it', async () => {
      mockCheckSessionAccess.mockResolvedValue({ allowed: true });
      mockCreateConversationInSession.mockResolvedValue(undefined);

      const deps = buildSessionToolsDeps();
      const result = await deps.createWorkerSession({ ...baseInput, workspace: 'ses-target' });

      expect(result).toEqual({ ok: true, workspaceId: 'ses-target' });
      expect(mockCheckSessionAccess).toHaveBeenCalledWith('user-1', 'ses-target');
      expect(mockCreateConversationInSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'ses-target' }),
      );
      expect(mockSpawnSession).not.toHaveBeenCalled();
    });

    test('a workspace the caller may not use reads as nonexistent — never distinguished from a missing id', async () => {
      mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'drive_access_denied' });

      const deps = buildSessionToolsDeps();
      const result = await deps.createWorkerSession({ ...baseInput, workspace: 'someone-elses-ses' });

      expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'workspace_not_found' }));
      expect(mockCreateConversationInSession).not.toHaveBeenCalled();
    });
  });
});
