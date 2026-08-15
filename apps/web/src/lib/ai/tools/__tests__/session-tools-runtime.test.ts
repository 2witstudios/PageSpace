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
  mockGetDriveIdsForUser,
  mockResolveDriveMembership,
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
  mockGetDriveIdsForUser: vi.fn(),
  mockResolveDriveMembership: vi.fn(),
  mockGetConversation: vi.fn(),
  mockGetAiAgent: vi.fn(),
}));

vi.mock('@/lib/agent-workspaces/agent-workspaces-runtime', () => ({
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
  getDriveIdsForUser: mockGetDriveIdsForUser,
}));
// The tenant gather is mocked (it reads the DB); the pure access decision and
// the pure redaction rule are deliberately REAL — the whole point of the
// shared-workspace listing is that it reuses those exact functions.
vi.mock('@pagespace/lib/services/agent-workspaces/agent-workspace-tenant', () => ({
  resolveDriveMembership: mockResolveDriveMembership,
}));
vi.mock('@/lib/repositories/conversation-repository', () => ({
  conversationRepository: { getConversation: mockGetConversation, getAiAgent: mockGetAiAgent },
}));
vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('@/lib/agent-workspaces/workspace-shells-runtime', () => ({
  getSessionShellStore: vi.fn(),
  killShellById: vi.fn(),
  listShells: vi.fn(),
  spawnShell: vi.fn(),
}));
const { mockAbortConversationStreams } = vi.hoisted(() => ({
  mockAbortConversationStreams: vi.fn(),
}));
vi.mock('@/lib/ai/core/abort-conversation-streams', () => ({
  abortConversationStreams: mockAbortConversationStreams,
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
  // Default to "still allowed". Every placement path runs the session-access
  // decision, so without a default `clearAllMocks` would leave it resolving
  // `undefined` and every unrelated test would fail on the access read rather
  // than on what it is actually asserting. Tests about revocation override it.
  mockCheckSessionAccess.mockResolvedValue({ allowed: true });
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

  // The binding is permanent; drive membership is not. A member who spawned a
  // worker into a shared workspace and then lost the drive still resolves to
  // that workspace here, so the early return has to re-run the permission
  // decision — otherwise this path hands a revoked member a worker, and with
  // it code execution, inside another tenant's live sandbox and filesystem.
  test('a bound session belonging to a drive the caller LOST refuses — revocation gates placement even though lifecycle state does not', async () => {
    mockFindSessionForConversation.mockResolvedValue(sessionRow);
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'drive_access_denied' });

    const resolved = await resolveCallerSessionForWorker('conv-1', 'user-1');

    expect(resolved).toEqual({ ok: false, reason: 'not_permitted' });
    expect(mockCheckSessionAccess).toHaveBeenCalledWith('user-1', 'ses-1');
    // Refused on permission, not by falling through to the minting path — a
    // fallthrough would quietly start a SECOND workspace for a revoked caller.
    expect(mockGetConversation).not.toHaveBeenCalled();
    expect(mockEnsureGlobalSandboxSession).not.toHaveBeenCalled();
  });

  test('an ENDED session the caller still has access to resolves — the check reads permission only, never lifecycle', async () => {
    const ended = { ...sessionRow, endedAt: new Date() };
    mockFindSessionForConversation.mockResolvedValue(ended);
    mockCheckSessionAccess.mockResolvedValue({ allowed: true });

    await expect(resolveCallerSessionForWorker('conv-1', 'user-1')).resolves.toEqual({
      ok: true,
      session: ended,
    });
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
    allowedDriveIds: [] as string[],
  };

  test('workspace omitted: resolves the caller\'s own session and creates the worker there', async () => {
    mockFindSessionForConversation.mockResolvedValue({ id: 'ses-caller', ownerId: 'user-1', endedAt: null });
    mockCreateConversationInSession.mockResolvedValue(undefined);

    const deps = buildSessionToolsDeps();
    const result = await deps.createWorkerSession(baseInput);

    expect(result).toEqual({ ok: true, workspaceId: 'ses-caller' });
    expect(mockCreateConversationInSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ses-caller', conversationId: 'worker-conv-new' }),
    );
    expect(mockSpawnSession).not.toHaveBeenCalled();
    // Placement into the caller's OWN bound workspace is gated by the same
    // session-access decision as an explicit workspaceId target. This used to
    // assert the opposite (`not.toHaveBeenCalled`), pinning the gap where a
    // permanent binding outlived the drive membership that justified it.
    expect(mockCheckSessionAccess).toHaveBeenCalledWith('user-1', 'ses-caller');
  });

  test('workspace omitted, but the caller LOST the drive: refused, and no worker is created', async () => {
    mockFindSessionForConversation.mockResolvedValue({ id: 'ses-caller', ownerId: 'user-1', endedAt: null });
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'drive_access_denied' });

    const deps = buildSessionToolsDeps();
    const result = await deps.createWorkerSession(baseInput);

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'not_permitted' }));
    expect(mockCreateConversationInSession).not.toHaveBeenCalled();
    expect(mockSpawnSession).not.toHaveBeenCalled();
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
        expect.objectContaining({ workspaceId: 'ses-fresh' }),
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
        expect.objectContaining({ workspaceId: 'ses-target' }),
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

// ============================================================================
// Tests for session-tools-runtime.ts — killWorker (kill_session's wired dep)
//
// CONTRACT PIN for kill_session's description claim "Workers share YOUR
// session's sandbox, so stopping one never tears the sandbox down" (spec §5;
// the pure-layer half lives in session-tools-contract.test.ts): the wired
// dep only aborts the worker's in-flight runs — it must never call the
// workspace-lifecycle endSession, and it reports spriteTornDown: false.
// ============================================================================

describe('killWorker — kill_session never tears the sandbox down', () => {
  test('aborts the worker conversation\'s own streams and nothing else — the workspace lifecycle is untouched', async () => {
    mockAbortConversationStreams.mockResolvedValue(undefined);

    const deps = buildSessionToolsDeps();
    const result = await deps.killWorker({
      conversationId: 'conv-worker',
      streamOwnerId: 'user-1',
      actingUserId: 'user-1',
    });

    expect(result).toEqual({ ok: true, spriteTornDown: false });
    expect(mockAbortConversationStreams).toHaveBeenCalledWith({ conversationId: 'conv-worker', userId: 'user-1' });
    expect(mockEndSession).not.toHaveBeenCalled();
  });

  test('aborts as the WORKER\'S OWNER, not the caller — otherwise a drive admin\'s kill silently no-ops', async () => {
    // `abortConversationStreams` filters `ai_stream_sessions` by user id, so
    // passing the acting admin here would match zero rows: the worker would keep
    // running and `kill_session` would report success. Authorization for the
    // cross-member kill is settled before this call (`checkWorkspaceEndAccess`);
    // this is only about addressing the right rows.
    mockAbortConversationStreams.mockResolvedValue(undefined);

    const deps = buildSessionToolsDeps();
    await deps.killWorker({
      conversationId: 'conv-worker',
      streamOwnerId: 'worker-owner',
      actingUserId: 'drive-admin',
    });

    expect(mockAbortConversationStreams).toHaveBeenCalledWith({
      conversationId: 'conv-worker',
      userId: 'worker-owner',
    });
  });

  test('a failed stream abort still reports success — the conversation and transcript survive regardless, and there is no sandbox to have failed on', async () => {
    mockAbortConversationStreams.mockRejectedValue(new Error('realtime unreachable'));

    const deps = buildSessionToolsDeps();
    const result = await deps.killWorker({
      conversationId: 'conv-worker',
      streamOwnerId: 'user-1',
      actingUserId: 'user-1',
    });

    expect(result).toEqual({ ok: true, spriteTornDown: false });
    expect(mockEndSession).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Tests for session-tools-runtime.ts — listSharedWorkspaces (discovery
// symmetry, PR #2336's flagged asymmetry)
//
// The spawn gate's explicit-workspaceId path admits any caller
// `checkSessionAccess` allows (owner OR drive member); discovery must
// enumerate by the SAME decision. These tests run the REAL pure gate
// (`decideAgentSessionAccess`) and the REAL redaction rule
// (`redactConversationTitleForViewer`) — only the IO gathers are mocked.
// ============================================================================

describe('listSharedWorkspaces — member-visible discovery, gated by the one session-access decision', () => {
  const VIEWER = 'user-1';
  const OTHER_OWNER = 'user-2';

  const sharedSession = {
    // Both ids, as the real DTO carries them.
    workspaceId: 'ses-shared',
    sessionId: 'ses-shared',
    driveId: 'drive-member',
    ownerId: OTHER_OWNER,
    name: 'team workspace',
    sandboxStatus: 'running' as const,
    createdAt: '2026-08-01T00:00:00.000Z',
    lastActiveAt: '2026-08-02T00:00:00.000Z',
    endedAt: null,
  };

  test('a drive the caller belongs to lists other members\' sessions; the caller\'s own rows and the current workspace are excluded; a page-permission-only drive (membership none) is never even queried', async () => {
    mockGetDriveIdsForUser.mockResolvedValue(['drive-member', 'drive-page-only']);
    mockResolveDriveMembership.mockImplementation(async ({ driveId }: { driveId: string }) =>
      driveId === 'drive-member' ? 'member' : 'none',
    );
    mockListSessions.mockResolvedValue([
      sharedSession,
      // The caller's OWN session in the shared drive — the own listing's job.
      { ...sharedSession, workspaceId: 'ses-mine', sessionId: 'ses-mine', ownerId: VIEWER },
      // The caller's CURRENT workspace — the top-level detail view.
      { ...sharedSession, workspaceId: 'ses-current', sessionId: 'ses-current' },
    ]);
    mockListSessionConversationsBulk.mockResolvedValue(new Map());

    const deps = buildSessionToolsDeps();
    const shared = await deps.listSharedWorkspaces({ userId: VIEWER, excludeWorkspaceId: 'ses-current' });

    expect(shared.map((w) => w.workspaceId)).toEqual(['ses-shared']);
    expect(shared[0]).toEqual(
      expect.objectContaining({ driveId: 'drive-member', name: 'team workspace', sandbox: 'running' }),
    );
    expect(mockListSessions).toHaveBeenCalledTimes(1);
    expect(mockListSessions).toHaveBeenCalledWith({ driveId: 'drive-member' });
    expect(mockListSessionConversationsBulk).toHaveBeenCalledWith(['ses-shared']);
  });

  test('a NON-member sees nothing: the same pure decision that refuses the spawn refuses the discovery', async () => {
    mockGetDriveIdsForUser.mockResolvedValue(['drive-page-only']);
    mockResolveDriveMembership.mockResolvedValue('none');

    const deps = buildSessionToolsDeps();
    const shared = await deps.listSharedWorkspaces({ userId: VIEWER });

    expect(shared).toEqual([]);
    expect(mockListSessions).not.toHaveBeenCalled();
  });

  test('worker titles route through the ONE redaction rule, which is ALSO the addressability rule: own and deliberately-shared titles, "(private thread)" for another member\'s private one', async () => {
    mockGetDriveIdsForUser.mockResolvedValue(['drive-member']);
    mockResolveDriveMembership.mockResolvedValue('member');
    mockListSessions.mockResolvedValue([sharedSession]);
    mockListSessionConversationsBulk.mockResolvedValue(
      new Map([
        [
          'ses-shared',
          [
            { conversationId: 'conv-mine', title: 'my research', agentPageId: null, lastMessageAt: new Date('2026-08-02T00:00:00.000Z'), ownerId: VIEWER, isShared: false },
            { conversationId: 'conv-shared', title: 'team notes', agentPageId: null, lastMessageAt: null, ownerId: OTHER_OWNER, isShared: true },
            { conversationId: 'conv-private', title: 'their secret', agentPageId: null, lastMessageAt: new Date('2026-08-01T12:00:00.000Z'), ownerId: OTHER_OWNER, isShared: false },
          ],
        ],
      ]),
    );

    const deps = buildSessionToolsDeps();
    const shared = await deps.listSharedWorkspaces({ userId: VIEWER });

    expect(shared).toHaveLength(1);
    // The COUNT is honest — every row survives redaction.
    expect(shared[0].workers).toHaveLength(3);
    expect(shared[0].workers.map((w) => w.name)).toEqual(['my research', 'team notes', '(private thread)']);
    // The real title never leaks anywhere in the redacted entry.
    expect(JSON.stringify(shared[0])).not.toContain('their secret');
    // Activity time survives redaction — the orchestration signal.
    expect(shared[0].workers[2].lastActiveAt).toBe('2026-08-01T12:00:00.000Z');
  });

  test('the redaction marker and unaddressability are the SAME predicate — a redacted row is one the verbs refuse', async () => {
    // The invariant that keeps this listing honest to an agent: it must never
    // print a name for a row the verbs would refuse, nor redact one they would
    // accept. Both read `isConversationVisibleToViewer`, so this pins the two
    // never being computed separately again.
    const { isConversationVisibleToViewer, redactConversationTitleForViewer, PRIVATE_THREAD_REDACTION } =
      await import('@pagespace/lib/agent-workspaces/redact-conversation-listing');

    for (const isShared of [true, false]) {
      const input = {
        viewerId: VIEWER,
        workspaceOwnerId: OTHER_OWNER,
        conversation: { ownerId: OTHER_OWNER, isShared, title: 'their secret' },
      };
      const named = redactConversationTitleForViewer(input) !== PRIVATE_THREAD_REDACTION;
      expect(named).toBe(isConversationVisibleToViewer(input));
    }
  });

  test('the member-visible set carries its own explicit bound (100, newest activity first) — unlike the own set, nothing structural caps it', async () => {
    mockGetDriveIdsForUser.mockResolvedValue(['drive-member']);
    mockResolveDriveMembership.mockResolvedValue('member');
    const many = Array.from({ length: 150 }, (_, i) => ({
      ...sharedSession,
      workspaceId: `ses-${String(i).padStart(3, '0')}`,
      sessionId: `ses-${String(i).padStart(3, '0')}`,
      lastActiveAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
    }));
    mockListSessions.mockResolvedValue(many);
    mockListSessionConversationsBulk.mockResolvedValue(new Map());

    const deps = buildSessionToolsDeps();
    const shared = await deps.listSharedWorkspaces({ userId: VIEWER });

    // MAX_MEMBER_VISIBLE_WORKSPACES — the documented member-visible bound.
    expect(shared).toHaveLength(100);
    // Newest activity first: the most recent 100 survive the cut.
    expect(shared[0].workspaceId).toBe('ses-149');
    expect(shared[99].workspaceId).toBe('ses-050');
  });
});

// ============================================================================
// Tests for session-tools-runtime.ts — listOwnWorkspaces
//
// OWNERSHIP IS NOT ACCESS (review finding — MAJOR).
//
// This listing filtered on `ownerId` alone, making it the one session-surface
// read with no access predicate while its sibling above ran the real gate on
// every row. `decideAgentSessionAccess` denies the OWNER of a workspace in a
// drive they have been removed from — "losing the drive loses its working
// contexts" — so an owner refused everywhere else was still handed the
// workspace's name, driveId, live sandbox status and every worker's sessionId
// by `list_sessions`' `otherWorkspaces`.
//
// Same construction as the suite above: the REAL pure decision, mocked IO.
// ============================================================================

describe('listOwnWorkspaces — owned, and separately still accessible', () => {
  const OWNER = 'user-1';

  const ownedSession = {
    workspaceId: 'ses-mine',
    sessionId: 'ses-mine',
    driveId: 'drive-a',
    ownerId: OWNER,
    name: 'my workspace',
    sandboxStatus: 'running' as const,
    createdAt: '2026-08-01T00:00:00.000Z',
    lastActiveAt: '2026-08-02T00:00:00.000Z',
    endedAt: null,
  };

  test('a workspace the caller OWNS in a drive they were removed from is dropped — the same decision that refuses the detail view refuses the listing', async () => {
    mockListSessions.mockResolvedValue([ownedSession]);
    mockResolveDriveMembership.mockResolvedValue('none');
    mockListSessionConversationsBulk.mockResolvedValue(new Map());

    const deps = buildSessionToolsDeps();
    const own = await deps.listOwnWorkspaces({ userId: OWNER });

    expect(own).toEqual([]);
    // Nothing downstream of the gate is even asked — no worker ids fetched for
    // a workspace the caller may not see.
    expect(mockListSessionConversationsBulk).not.toHaveBeenCalled();
  });

  test('membership is resolved once per DRIVE, not once per workspace', async () => {
    mockListSessions.mockResolvedValue([
      ownedSession,
      { ...ownedSession, workspaceId: 'ses-mine-2', sessionId: 'ses-mine-2' },
      { ...ownedSession, workspaceId: 'ses-other-drive', sessionId: 'ses-other-drive', driveId: 'drive-b' },
    ]);
    mockResolveDriveMembership.mockResolvedValue('member');
    mockListSessionConversationsBulk.mockResolvedValue(new Map());

    const deps = buildSessionToolsDeps();
    const own = await deps.listOwnWorkspaces({ userId: OWNER });

    expect(own.map((w) => w.workspaceId)).toEqual(['ses-mine', 'ses-mine-2', 'ses-other-drive']);
    expect(mockResolveDriveMembership).toHaveBeenCalledTimes(2);
    expect(mockResolveDriveMembership.mock.calls.map(([arg]) => (arg as { driveId: string }).driveId).sort())
      .toEqual(['drive-a', 'drive-b']);
  });

  test('a GLOBAL-assistant workspace (no drive) survives on ownership alone, without a membership lookup', async () => {
    mockListSessions.mockResolvedValue([{ ...ownedSession, driveId: null }]);
    mockListSessionConversationsBulk.mockResolvedValue(new Map());

    const deps = buildSessionToolsDeps();
    const own = await deps.listOwnWorkspaces({ userId: OWNER });

    // Owner-only by construction — there is no drive to derive access from,
    // and asking for membership in `null` would be a denial, not a question.
    expect(own.map((w) => w.workspaceId)).toEqual(['ses-mine']);
    expect(mockResolveDriveMembership).not.toHaveBeenCalled();
  });

  test('the revoked drive is dropped while the caller\'s other drives still list — a denial is per-workspace, not a collapse', async () => {
    mockListSessions.mockResolvedValue([
      ownedSession,
      { ...ownedSession, workspaceId: 'ses-kept', sessionId: 'ses-kept', driveId: 'drive-b' },
    ]);
    mockResolveDriveMembership.mockImplementation(async ({ driveId }: { driveId: string }) =>
      driveId === 'drive-a' ? 'none' : 'member',
    );
    mockListSessionConversationsBulk.mockResolvedValue(new Map());

    const deps = buildSessionToolsDeps();
    const own = await deps.listOwnWorkspaces({ userId: OWNER });

    expect(own.map((w) => w.workspaceId)).toEqual(['ses-kept']);
    expect(mockListSessionConversationsBulk).toHaveBeenCalledWith(['ses-kept']);
  });

  test('the bound workspace is still excluded — the detail view owns it', async () => {
    mockListSessions.mockResolvedValue([
      ownedSession,
      { ...ownedSession, workspaceId: 'ses-current', sessionId: 'ses-current' },
    ]);
    mockResolveDriveMembership.mockResolvedValue('member');
    mockListSessionConversationsBulk.mockResolvedValue(new Map());

    const deps = buildSessionToolsDeps();
    const own = await deps.listOwnWorkspaces({ userId: OWNER, excludeWorkspaceId: 'ses-current' });

    expect(own.map((w) => w.workspaceId)).toEqual(['ses-mine']);
  });
});
