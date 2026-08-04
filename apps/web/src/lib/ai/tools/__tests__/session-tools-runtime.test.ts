import { describe, test, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// Tests for session-tools-runtime.ts — resolveCallerSessionForWorker
//
// A worker joins its SPAWNER's session. The one auto-bind exception is a
// GLOBAL conversation (always minted session-less, nothing else ever claims
// it): it gets the same spawn+claim its first sandbox tool call would
// trigger, so spawn_session works on deployments where the compute
// kill-switch is off and no sandbox tool exists to run the acquire path
// (review #2326).
// ============================================================================

const {
  mockFindSessionForConversation,
  mockEnsureGlobalSandboxSession,
  mockGetConversation,
} = vi.hoisted(() => ({
  mockFindSessionForConversation: vi.fn(),
  mockEnsureGlobalSandboxSession: vi.fn(),
  mockGetConversation: vi.fn(),
}));

vi.mock('@/lib/agent-sessions/agent-sessions-runtime', () => ({
  findSessionForConversation: mockFindSessionForConversation,
  ensureGlobalSandboxSession: mockEnsureGlobalSandboxSession,
  createConversationInSession: vi.fn(),
  provisionSessionSandbox: vi.fn(),
  getAgentSessionStore: vi.fn(),
}));
vi.mock('@/lib/repositories/conversation-repository', () => ({
  conversationRepository: { getConversation: mockGetConversation },
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

const sessionRow = { id: 'ses-1', ownerId: 'user-1' };

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

  test('an unbound GLOBAL conversation mints and binds a session via the shared spawn+claim primitive', async () => {
    mockFindSessionForConversation.mockResolvedValue(null);
    mockGetConversation.mockResolvedValue({ id: 'conv-g', type: 'global' });
    mockEnsureGlobalSandboxSession.mockResolvedValue({ ok: true, session: sessionRow });

    const resolved = await resolveCallerSessionForWorker('conv-g', 'user-1');

    expect(resolved).toEqual({ ok: true, session: sessionRow });
    expect(mockEnsureGlobalSandboxSession).toHaveBeenCalledWith('conv-g', 'user-1');
  });

  test('an unbound PAGE conversation keeps the truthful no_session refusal — never a lazily-minted per-thread environment', async () => {
    mockFindSessionForConversation.mockResolvedValue(null);
    mockGetConversation.mockResolvedValue({ id: 'conv-p', type: 'page' });

    const resolved = await resolveCallerSessionForWorker('conv-p', 'user-1');

    expect(resolved).toEqual({ ok: false, reason: 'no_session' });
    expect(mockEnsureGlobalSandboxSession).not.toHaveBeenCalled();
  });

  test('a session-cap refusal surfaces as session_limit_reached, not a generic no_session', async () => {
    mockFindSessionForConversation.mockResolvedValue(null);
    mockGetConversation.mockResolvedValue({ id: 'conv-g', type: 'global' });
    mockEnsureGlobalSandboxSession.mockResolvedValue({ ok: false, reason: 'session_limit_reached' });

    const resolved = await resolveCallerSessionForWorker('conv-g', 'user-1');

    expect(resolved).toEqual({ ok: false, reason: 'session_limit_reached' });
  });

  test('a transient spawn failure degrades to no_session — the caller retries a fresh spawn later', async () => {
    mockFindSessionForConversation.mockResolvedValue(null);
    mockGetConversation.mockResolvedValue({ id: 'conv-g', type: 'global' });
    mockEnsureGlobalSandboxSession.mockResolvedValue({ ok: false, reason: 'spawn_failed' });

    const resolved = await resolveCallerSessionForWorker('conv-g', 'user-1');

    expect(resolved).toEqual({ ok: false, reason: 'no_session' });
  });
});
