import { describe, it, expect, vi, beforeEach } from 'vitest';

// The runtime module wires the real DB-backed resolver deps and the
// session-anchored `acquireSandbox`. The DB client and the shared
// agent-sessions runtime are mocked so the module loads (and acquires) without
// a database or a Sprites SDK; `createResolveSandboxActorContext` is exercised
// with injected fakes and never touches the mocked defaults.
const {
  mockFindSessionForConversation,
  mockProvisionSessionSandbox,
  mockMeasureWarmSessionStorage,
  mockCheckSessionRuntimeGuardrail,
  mockRecordSessionActivity,
  mockEnsureGlobalSandboxSession,
  mockGetConversation,
} = vi.hoisted(() => ({
  mockFindSessionForConversation: vi.fn(),
  mockProvisionSessionSandbox: vi.fn(),
  mockMeasureWarmSessionStorage: vi.fn(async () => {}),
  mockCheckSessionRuntimeGuardrail: vi.fn(),
  mockRecordSessionActivity: vi.fn(),
  mockEnsureGlobalSandboxSession: vi.fn(),
  mockGetConversation: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('@/lib/agent-sessions/agent-sessions-runtime', () => ({
  findSessionForConversation: mockFindSessionForConversation,
  provisionSessionSandbox: mockProvisionSessionSandbox,
  // Opportunistic storage measurement rides this path fire-and-forget. Stubbed
  // so the module loads; the assertions below deliberately do not await it,
  // which is the property that matters — a billing observation must never delay
  // or fail a tool call.
  measureWarmSessionStorage: mockMeasureWarmSessionStorage,
  ensureGlobalSandboxSession: mockEnsureGlobalSandboxSession,
}));
vi.mock('@/lib/repositories/conversation-repository', () => ({
  conversationRepository: { getConversation: mockGetConversation },
}));
vi.mock('@pagespace/lib/services/sandbox/quota', () => ({
  acquireCodeExecutionSlot: vi.fn(() => true),
  releaseCodeExecutionSlot: vi.fn(),
  checkSessionRuntimeGuardrail: mockCheckSessionRuntimeGuardrail,
  recordSessionActivity: mockRecordSessionActivity,
}));
vi.mock('@pagespace/lib/services/sandbox/sandbox-billing', () => ({
  defaultSandboxBillingDeps: {
    resolvePayerId: vi.fn(),
    gate: vi.fn(),
    trackUsage: vi.fn(),
    releaseHold: vi.fn(),
  },
}));

import {
  createResolveSandboxActorContext,
  buildRealSandboxRunDeps,
  buildSandboxTools,
  type ResolveSandboxActorContextDeps,
} from '../sandbox-tools-runtime';
import type { ToolExecutionContext } from '../../core/types';
import type { AcquireSandboxRequest } from '@pagespace/lib/services/sandbox/tool-runners';
import type { AgentSessionRecord } from '@pagespace/lib/services/agent-sessions/agent-sessions-store';

function makeDeps(overrides: Partial<ResolveSandboxActorContextDeps> = {}): ResolveSandboxActorContextDeps {
  return {
    findDrive: async () => ({ ownerId: 'tenant-1' }),
    findPageDriveId: async () => undefined,
    findUser: async () => ({ subscriptionTier: 'pro' }),
    getActorInfo: async () => ({ actorEmail: 'u1@example.com', actorDisplayName: 'User One' }),
    ...overrides,
  };
}

const baseGlobalContext: ToolExecutionContext = {
  userId: 'u1',
  conversationId: 'conv-1',
  chatSource: { type: 'global' },
};

const basePageContext: ToolExecutionContext = {
  userId: 'u1',
  conversationId: 'conv-1',
  chatSource: { type: 'page', agentPageId: 'page-agent-1' },
};

describe('resolveSandboxActorContext', () => {
  describe('given no context (unauthenticated)', () => {
    it('should return an authentication error', async () => {
      const resolve = createResolveSandboxActorContext(makeDeps());
      const result = await resolve(undefined);
      expect('error' in result).toBe(true);
      if (!('error' in result)) return;
      expect(result.error).toContain('Code execution requires an authenticated user.');
    });
  });

  describe('given userId present but no conversationId', () => {
    it('should return a conversation error', async () => {
      const context: ToolExecutionContext = { userId: 'u1', chatSource: { type: 'global' } };
      const resolve = createResolveSandboxActorContext(makeDeps());
      const result = await resolve(context);
      expect('error' in result).toBe(true);
      if (!('error' in result)) return;
      expect(result.error).toContain('Code execution requires a conversation.');
    });
  });

  describe('given chatSource type "page" and currentDrive present', () => {
    it('should resolve with driveId and tenantId from drive ownerId', async () => {
      const context: ToolExecutionContext = {
        ...basePageContext,
        locationContext: { currentDrive: { id: 'd1', name: 'Drive 1', slug: 'drive-1' } },
      };
      const resolve = createResolveSandboxActorContext(
        makeDeps({ findDrive: async () => ({ ownerId: 'owner-1' }) }),
      );
      const result = await resolve(context);
      expect('error' in result).toBe(false);
      if ('error' in result) return;
      expect(result.driveId).toBe('d1');
      expect(result.tenantId).toBe('owner-1');
    });

    it("should resolve the quota tier from the PAYER (drive owner), not the actor (review #2326)", async () => {
      // A free-tier collaborator in a Pro-owned drive: every quota check
      // downstream (`isSandboxAvailable` + the concurrency ceiling) consumes
      // ctx.tier, so loading the actor's own tier here denied the very access
      // the payer-based eligibility gate had just granted.
      const context: ToolExecutionContext = {
        ...basePageContext,
        locationContext: { currentDrive: { id: 'd1', name: 'Drive 1', slug: 'drive-1' } },
      };
      const tierLookups: string[] = [];
      const resolve = createResolveSandboxActorContext(
        makeDeps({
          findDrive: async () => ({ ownerId: 'owner-1' }),
          findUser: async (userId) => {
            tierLookups.push(userId);
            return userId === 'owner-1'
              ? { subscriptionTier: 'pro' }
              : { subscriptionTier: 'free' };
          },
        }),
      );
      const result = await resolve(context);
      expect('error' in result).toBe(false);
      if ('error' in result) return;
      expect(result.tier).toBe('pro');
      expect(tierLookups).toEqual(['owner-1']);
    });
  });

  describe('given chatSource type "global", currentDrive present, but drive not found in DB', () => {
    it('should return an active drive error', async () => {
      const context: ToolExecutionContext = {
        ...baseGlobalContext,
        locationContext: { currentDrive: { id: 'd-missing', name: 'X', slug: 'x' } },
      };
      const resolve = createResolveSandboxActorContext(
        makeDeps({ findDrive: async () => undefined }),
      );
      const result = await resolve(context);
      expect('error' in result).toBe(true);
      if (!('error' in result)) return;
      expect(result.error).toContain('Code execution requires an active drive.');
    });
  });

  describe('given chatSource type "global" and no currentDrive', () => {
    it('should resolve successfully with driveId undefined and tenantId equal to userId', async () => {
      const resolve = createResolveSandboxActorContext(makeDeps());
      const result = await resolve(baseGlobalContext);
      expect('error' in result).toBe(false);
      if ('error' in result) return;
      expect(result.userId).toBe('u1');
      expect(result.tenantId).toBe('u1');
      expect(result.driveId).toBeUndefined();
      expect(result.conversationId).toBe('conv-1');
      expect(result.actorEmail).toBe('u1@example.com');
    });
  });

  describe('given chatSource type "page" and no currentDrive', () => {
    it('should return error containing "Code execution requires an active drive."', async () => {
      const resolve = createResolveSandboxActorContext(makeDeps());
      const result = await resolve(basePageContext);
      expect('error' in result).toBe(true);
      if (!('error' in result)) return;
      expect(result.error).toContain('Code execution requires an active drive.');
    });
  });

  describe('given chatSource type "page", no currentDrive, and agent page has a drive', () => {
    it('should resolve driveId from the agent page before applying the drive tenant lookup', async () => {
      const seenDriveIds: string[] = [];
      const resolve = createResolveSandboxActorContext(
        makeDeps({
          findPageDriveId: async (pageId) => pageId === 'page-agent-1' ? 'drive-from-page' : undefined,
          findDrive: async (driveId) => {
            seenDriveIds.push(driveId);
            return { ownerId: 'tenant-from-page-drive' };
          },
        }),
      );

      const result = await resolve(basePageContext);

      expect('error' in result).toBe(false);
      if ('error' in result) return;
      expect(result.driveId).toBe('drive-from-page');
      expect(result.tenantId).toBe('tenant-from-page-drive');
      expect(seenDriveIds).toEqual(['drive-from-page']);
    });
  });

  describe('given chatSource type "global" and currentDrive present', () => {
    it('should resolve with driveId from locationContext and tenantId from drive ownerId', async () => {
      const context: ToolExecutionContext = {
        ...baseGlobalContext,
        locationContext: {
          currentDrive: { id: 'd1', name: 'My Drive', slug: 'my-drive' },
        },
      };
      const resolve = createResolveSandboxActorContext(
        makeDeps({ findDrive: async () => ({ ownerId: 'tenant-from-drive' }) }),
      );
      const result = await resolve(context);
      expect('error' in result).toBe(false);
      if ('error' in result) return;
      expect(result.driveId).toBe('d1');
      expect(result.tenantId).toBe('tenant-from-drive');
    });
  });

  describe('turnId stamping (Sprites Platform Alignment 5-2)', () => {
    // Deliberately fresh, standalone context objects per test (not the shared
    // module-level `baseGlobalContext`, which sibling tests above mutate
    // in-place via stamping — reusing it here would leak a turnId across
    // tests and defeat the very thing being asserted).
    function freshGlobalContext(): ToolExecutionContext {
      return { userId: 'u1', conversationId: 'conv-1', chatSource: { type: 'global' } };
    }

    it('stamps a turnId onto the resolved ctx when the raw context has none yet', async () => {
      const resolve = createResolveSandboxActorContext(makeDeps());
      const result = await resolve(freshGlobalContext());
      expect('error' in result).toBe(false);
      if ('error' in result) return;
      expect(result.turnId).toBeTruthy();
    });

    it('reuses the SAME turnId across multiple tool calls sharing one context object (one streamText run)', async () => {
      const resolve = createResolveSandboxActorContext(makeDeps());
      const sharedContext = freshGlobalContext();

      const first = await resolve(sharedContext);
      const second = await resolve(sharedContext);

      expect('error' in first).toBe(false);
      expect('error' in second).toBe(false);
      if ('error' in first || 'error' in second) return;
      expect(first.turnId).toBe(second.turnId);
      // The stamp is visible on the raw context too — later non-sandbox code
      // paths reading it (or a second resolve call) see the same value.
      expect(sharedContext.turnId).toBe(first.turnId);
    });

    it('mints a DIFFERENT turnId for a different context object (a new streamText run)', async () => {
      const resolve = createResolveSandboxActorContext(makeDeps());
      const first = await resolve(freshGlobalContext());
      const second = await resolve(freshGlobalContext());
      expect('error' in first).toBe(false);
      expect('error' in second).toBe(false);
      if ('error' in first || 'error' in second) return;
      expect(first.turnId).not.toBe(second.turnId);
    });
  });
});

// The SESSION-anchored acquisition (THE HANDLE SOURCE): `conversationId` IS the
// session id, `ensureSession` + `provisionSessionSandbox` are the one shared
// provisioning path, and the continuous-runtime guardrail is keyed by the
// session id — the exact discipline the deleted machine path keyed by page id.
describe('buildRealSandboxRunDeps.acquireSandbox (session-anchored)', () => {
  function makeSessionRecord(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
    const now = new Date('2026-06-01T00:00:00Z');
    return {
      id: 'ses-1',
      ownerId: 'u1',
      driveId: 'd1',
      name: null,
      sessionKey: null,
      sandboxId: null,
      spriteInstanceId: null,
      egressPolicyToken: null,
      teardownRequestedAt: null,
      spriteTornDownAt: null,
      storageLastBilledAt: now,
      storageMeasuredBytes: null,
      storageMeasuredAt: null,
      lastActiveAt: null,
      endedAt: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  const sessionRecord = makeSessionRecord();

  function baseInput(overrides: Partial<AcquireSandboxRequest> = {}): AcquireSandboxRequest {
    return {
      tenantId: 't1',
      driveId: 'd1',
      userId: 'u1',
      agentPageId: 'agent-1',
      conversationId: 'conv-1',
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckSessionRuntimeGuardrail.mockReturnValue({ allowed: true });
    mockFindSessionForConversation.mockResolvedValue(sessionRecord);
    mockProvisionSessionSandbox.mockResolvedValue({ ok: true, sandboxId: 'sbx-1', resumed: false, sessionId: 'ws-1' });
    // Most tests in this block exercise a PAGE conversation (`baseInput` sets
    // `agentPageId`) — page conversations never auto-provision, so the default
    // here matches that and the global-only tests below override it.
    mockGetConversation.mockResolvedValue({ type: 'page' });
    mockEnsureGlobalSandboxSession.mockResolvedValue({ ok: false, reason: 'no_session' });
  });

  it('should WIRE the activity-feed seam — an unwired optional dep is a silently dead feature', async () => {
    // `notifyShellActivity` is optional on `SandboxRunDeps`, and the runner
    // no-ops when it is absent. That is precisely how this feature spent the
    // whole rebuild dead: the realtime handler was implemented, tested and
    // wired with real deps, its doc said "apps/web posts here after a
    // successful bash run" — and nothing here supplied the dep, so nothing ever
    // posted. Deleting the wiring line passed every other test in this file.
    //
    // Asserting presence rather than behaviour is the point: the behaviour is
    // covered in `tool-runners`, and the only thing that was ever missing was
    // the connection between the two.
    const deps = buildRealSandboxRunDeps();
    expect(typeof deps.notifyShellActivity).toBe('function');
  });

  it('should measure against the ACQUIRED sandbox\'s generation, not whatever the row says later', async () => {
    // The storage CAS is only as good as the id handed to it. This seam is fed
    // the sandbox the tool run ALREADY acquired, and the measurement is
    // fire-and-forget — so between acquiring it and persisting, the session can
    // be torn down and re-provisioned. Reading the instance from the session row
    // at persist time would then name generation B while `du` walked A's disk,
    // and the CAS would "succeed" against B with A's bytes: the exact write the
    // CAS exists to reject, waved through by its own guard.
    const deps = buildRealSandboxRunDeps();
    expect(typeof deps.measureStorage).toBe('function');

    const sandbox = {
      spriteInstanceId: 'instance-A',
      runCommand: vi.fn(async () => ({ exitCode: 0, stdout: '1\t/workspace', stderr: '' })),
    };
    await deps.measureStorage!({ sandbox: sandbox as never, sessionId: 'conv-1' });

    const [call] = mockMeasureWarmSessionStorage.mock.calls as unknown as [
      [{ sessionId: string; attach: () => Promise<{ spriteInstanceId: string | null } | null> }],
    ];
    expect(call[0].sessionId).toBe('conv-1');
    const attached = await call[0].attach();
    expect(attached?.spriteInstanceId).toBe('instance-A');
  });

  it('given no conversationId, should fail as provision_failed/missing_conversation_id without touching the session runtime', async () => {
    const deps = buildRealSandboxRunDeps();
    const result = await deps.acquireSandbox(baseInput({ conversationId: undefined }));
    expect(result).toEqual({ ok: false, reason: 'provision_failed', cause: 'missing_conversation_id' });
    expect(mockFindSessionForConversation).not.toHaveBeenCalled();
    expect(mockProvisionSessionSandbox).not.toHaveBeenCalled();
    expect(mockCheckSessionRuntimeGuardrail).not.toHaveBeenCalled();
  });

  it('given the runtime guardrail denies, should short-circuit BEFORE provisioning — keyed by the SESSION id', async () => {
    mockCheckSessionRuntimeGuardrail.mockReturnValue({ allowed: false, reason: 'session_runtime_exceeded' });
    const deps = buildRealSandboxRunDeps();
    const result = await deps.acquireSandbox(baseInput());
    expect(result).toEqual({ ok: false, reason: 'session_runtime_exceeded' });
    // One runtime budget per WORKSPACE, however many threads work in it.
    expect(mockCheckSessionRuntimeGuardrail).toHaveBeenCalledWith({
      sessionId: 'ses-1',
      now: expect.any(Number),
    });
    expect(mockProvisionSessionSandbox).not.toHaveBeenCalled();
    expect(mockRecordSessionActivity).not.toHaveBeenCalled();
  });

  it('given a PAGE conversation with NO session, should DENY — page agents still require an explicit "New session" spawn', async () => {
    // Per-conversation minting is exactly the conflation the session model
    // removed; it is what made panes unable to share a sandbox. Page agents
    // never auto-provision — only the global-assistant case below does.
    mockFindSessionForConversation.mockResolvedValue(null);
    mockGetConversation.mockResolvedValue({ type: 'page' });
    const deps = buildRealSandboxRunDeps();
    const result = await deps.acquireSandbox(baseInput());
    expect(result).toEqual({ ok: false, reason: 'no_session' });
    expect(mockEnsureGlobalSandboxSession).not.toHaveBeenCalled();
    expect(mockProvisionSessionSandbox).not.toHaveBeenCalled();
    expect(mockRecordSessionActivity).not.toHaveBeenCalled();
  });

  it('given a GLOBAL conversation with NO session, should auto-provision one and proceed to provision its sandbox', async () => {
    // The default Global Assistant chat is always minted session-less and
    // nothing else ever claims it — restore the pre-refactor "own machine"
    // parity by auto-provisioning a REAL session the first time it's needed,
    // through the exact same spawn+claim primitive a manual "New session"
    // spawn uses.
    mockFindSessionForConversation.mockResolvedValue(null);
    mockGetConversation.mockResolvedValue({ type: 'global' });
    mockEnsureGlobalSandboxSession.mockResolvedValue({ ok: true, session: sessionRecord });
    const deps = buildRealSandboxRunDeps();
    const result = await deps.acquireSandbox(baseInput({ agentPageId: undefined }));
    expect(mockEnsureGlobalSandboxSession).toHaveBeenCalledWith('conv-1', 'u1');
    expect(mockProvisionSessionSandbox).toHaveBeenCalledWith(sessionRecord, 'u1');
    expect(result).toMatchObject({ ok: true, sandboxId: 'sbx-1' });
  });


  it('given a GLOBAL conversation whose auto-provisioning was ATTEMPTED and failed (any reason), should DENY as provision_failed with that reason as the cause — never the plain no_session', async () => {
    // Once an attempt was made, "no_session" alone would be misleading (it
    // reads as "nothing was ever tried"); provision_failed/cause names WHY.
    mockFindSessionForConversation.mockResolvedValue(null);
    mockGetConversation.mockResolvedValue({ type: 'global' });
    mockEnsureGlobalSandboxSession.mockResolvedValue({ ok: false, reason: 'spawn_failed' });
    const deps = buildRealSandboxRunDeps();
    const result = await deps.acquireSandbox(baseInput({ agentPageId: undefined }));
    expect(result).toEqual({ ok: false, reason: 'provision_failed', cause: 'spawn_failed' });
    expect(mockProvisionSessionSandbox).not.toHaveBeenCalled();
    expect(mockRecordSessionActivity).not.toHaveBeenCalled();
  });

  it('given a GLOBAL conversation with NO session, and the owner is at their session cap, should DENY with the specific session_limit_reached cause', async () => {
    // A distinct, actionable denial ("end an existing session first") —
    // collapsing it into the generic no_session message would tell an agent
    // at its owner's session cap to do something that can't help.
    mockFindSessionForConversation.mockResolvedValue(null);
    mockGetConversation.mockResolvedValue({ type: 'global' });
    mockEnsureGlobalSandboxSession.mockResolvedValue({ ok: false, reason: 'session_limit_reached' });
    const deps = buildRealSandboxRunDeps();
    const result = await deps.acquireSandbox(baseInput({ agentPageId: undefined }));
    expect(result).toEqual({ ok: false, reason: 'provision_failed', cause: 'session_limit_reached' });
    expect(mockProvisionSessionSandbox).not.toHaveBeenCalled();
    expect(mockRecordSessionActivity).not.toHaveBeenCalled();
  });

  it('given two conversations bound to ONE session, both should acquire the SAME sandbox', async () => {
    // R0's payoff test at the tool layer: sandbox sharing is structural. Both
    // threads resolve one session row, and provisioning folds ITS id — so both
    // acquisitions name one sandboxId with no shared id threaded anywhere.
    mockProvisionSessionSandbox.mockResolvedValue({ ok: true, sandboxId: 'sbx-shared', resumed: true, sessionId: 'ws-1' });
    const deps = buildRealSandboxRunDeps();

    const a = await deps.acquireSandbox(baseInput({ conversationId: 'conv-a' }));
    const b = await deps.acquireSandbox(baseInput({ conversationId: 'conv-b' }));

    expect(a).toMatchObject({ ok: true, sandboxId: 'sbx-shared' });
    expect(b).toMatchObject({ ok: true, sandboxId: 'sbx-shared' });
    expect(mockFindSessionForConversation.mock.calls).toEqual([['conv-a'], ['conv-b']]);
    // Both provisions received the SAME session row — the structural share.
    expect(mockProvisionSessionSandbox).toHaveBeenNthCalledWith(1, sessionRecord, 'u1');
    expect(mockProvisionSessionSandbox).toHaveBeenNthCalledWith(2, sessionRecord, 'u1');
  });

  it('given provisioning is denied as not_authorized, should map to the runners\' no_drive_access vocabulary', async () => {
    mockProvisionSessionSandbox.mockResolvedValue({ ok: false, reason: 'denied', denial: 'not_authorized' });
    const deps = buildRealSandboxRunDeps();
    const result = await deps.acquireSandbox(baseInput());
    expect(result).toEqual({ ok: false, reason: 'no_drive_access' });
    expect(mockRecordSessionActivity).not.toHaveBeenCalled();
  });

  it('given provisioning is denied for any other reason, should map to provision_failed with the denial as the cause', async () => {
    mockProvisionSessionSandbox.mockResolvedValue({ ok: false, reason: 'denied', denial: 'session_torn_down' });
    const deps = buildRealSandboxRunDeps();
    const result = await deps.acquireSandbox(baseInput());
    expect(result).toEqual({ ok: false, reason: 'provision_failed', cause: 'session_torn_down' });
  });

  it('given a non-denial provisioning failure, should map to provision_failed preferring the detail as the cause', async () => {
    mockProvisionSessionSandbox.mockResolvedValue({ ok: false, reason: 'race_lost', detail: 'cas beaten' });
    const deps = buildRealSandboxRunDeps();
    const result = await deps.acquireSandbox(baseInput());
    expect(result).toEqual({ ok: false, reason: 'provision_failed', cause: 'cas beaten' });
  });

  it('given a non-denial provisioning failure without detail, should fall back to the reason as the cause', async () => {
    mockProvisionSessionSandbox.mockResolvedValue({ ok: false, reason: 'egress_denied' });
    const deps = buildRealSandboxRunDeps();
    const result = await deps.acquireSandbox(baseInput());
    expect(result).toEqual({ ok: false, reason: 'provision_failed', cause: 'egress_denied' });
  });

  it('given a successful provision, should return the sandbox with pageId = the agent page and record activity keyed by the session id', async () => {
    mockProvisionSessionSandbox.mockResolvedValue({ ok: true, sandboxId: 'sbx-1', resumed: true, sessionId: 'ws-1' });
    const deps = buildRealSandboxRunDeps();
    const result = await deps.acquireSandbox(baseInput());
    expect(result).toEqual({ ok: true, sandboxId: 'sbx-1', resumed: true, sessionId: 'ses-1', pageId: 'agent-1' });
    expect(mockFindSessionForConversation).toHaveBeenCalledWith('conv-1');
    expect(mockProvisionSessionSandbox).toHaveBeenCalledWith(sessionRecord, 'u1');
    expect(mockRecordSessionActivity).toHaveBeenCalledWith({
      sessionId: 'ses-1',
      now: expect.any(Number),
    });
  });

  it('given no agentPageId (a global-assistant conversation), should return no pageId', async () => {
    const deps = buildRealSandboxRunDeps();
    const result = await deps.acquireSandbox(baseInput({ agentPageId: undefined, driveId: undefined }));
    expect(result).toEqual({ ok: true, sandboxId: 'sbx-1', resumed: false, sessionId: 'ses-1', pageId: undefined });
    expect(mockFindSessionForConversation).toHaveBeenCalledWith('conv-1');
  });
});

// Billing attribution resolve (issue #2260): a CHEAP session-row read (no
// provisioning) so `withMachineBilling` can resolve the payer from the
// SESSION's own driveId/ownerId before gating — never from the caller's
// surface drive/tenant.
describe('buildRealSandboxRunDeps.resolveBillingSession', () => {
  function makeSessionRecord(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
    const now = new Date('2026-06-01T00:00:00Z');
    return {
      id: 'ses-1',
      ownerId: 'u1',
      driveId: 'd1',
      name: null,
      sessionKey: null,
      sandboxId: null,
      spriteInstanceId: null,
      egressPolicyToken: null,
      teardownRequestedAt: null,
      spriteTornDownAt: null,
      storageLastBilledAt: now,
      storageMeasuredBytes: null,
      storageMeasuredAt: null,
      lastActiveAt: null,
      endedAt: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves the session's own driveId/ownerId — NOT ctx.tenantId/ctx.driveId, which may be a different drive entirely", async () => {
    mockFindSessionForConversation.mockResolvedValue(
      makeSessionRecord({ id: 'shared-session-1', driveId: 'session-own-drive', ownerId: 'session-own-owner' }),
    );
    const deps = buildRealSandboxRunDeps();

    const result = await deps.resolveBillingSession?.({
      userId: 'u1',
      tenantId: 'surface-tenant-should-never-be-used',
      driveId: 'surface-drive-should-never-be-used',
      conversationId: 'conv-1',
      actorEmail: 'u1@example.com',
      tier: 'pro',
    });

    expect(result).toEqual({ sessionId: 'shared-session-1', driveId: 'session-own-drive', ownerId: 'session-own-owner' });
    expect(mockFindSessionForConversation).toHaveBeenCalledWith('conv-1');
  });

  it('given a global-assistant session (null driveId), resolves driveId null and the session ownerId', async () => {
    mockFindSessionForConversation.mockResolvedValue(makeSessionRecord({ driveId: null, ownerId: 'global-owner-1' }));
    const deps = buildRealSandboxRunDeps();

    const result = await deps.resolveBillingSession?.({
      userId: 'u1',
      tenantId: 'u1',
      conversationId: 'conv-1',
      actorEmail: 'u1@example.com',
      tier: 'pro',
    });

    expect(result).toEqual({ sessionId: 'ses-1', driveId: null, ownerId: 'global-owner-1' });
  });

  it('given no conversationId, resolves null WITHOUT touching the session runtime', async () => {
    const deps = buildRealSandboxRunDeps();

    const result = await deps.resolveBillingSession?.({
      userId: 'u1',
      tenantId: 'u1',
      conversationId: undefined as unknown as string,
      actorEmail: 'u1@example.com',
      tier: 'pro',
    });

    expect(result).toBeNull();
    expect(mockFindSessionForConversation).not.toHaveBeenCalled();
  });

  it('given a PAGE conversation with no session yet, resolves null (page agents never auto-provision)', async () => {
    mockFindSessionForConversation.mockResolvedValue(null);
    mockGetConversation.mockResolvedValue({ type: 'page' });
    const deps = buildRealSandboxRunDeps();

    const result = await deps.resolveBillingSession?.({
      userId: 'u1',
      tenantId: 'u1',
      conversationId: 'conv-legacy',
      actorEmail: 'u1@example.com',
      tier: 'pro',
    });

    expect(result).toBeNull();
    expect(mockEnsureGlobalSandboxSession).not.toHaveBeenCalled();
  });

  it('given a GLOBAL conversation with no session yet, auto-provisions one and resolves ITS driveId/ownerId — closes the credit-gate bypass (review finding P1, PR #2314)', async () => {
    // Before this fix, a session-less global conversation resolved null here
    // (the old "nothing to bill, run() will just deny" assumption), but
    // acquireSandbox's own auto-provisioning made run() actually SUCCEED —
    // so a credit-exhausted user's first message executed completely
    // unmetered. resolveBillingSession must see the SAME auto-provisioned
    // session acquireSandbox is about to act on, not a stale "no session".
    mockFindSessionForConversation.mockResolvedValue(null);
    mockGetConversation.mockResolvedValue({ type: 'global' });
    const provisioned = makeSessionRecord({ id: 'auto-ses-1', driveId: null, ownerId: 'u1' });
    mockEnsureGlobalSandboxSession.mockResolvedValue({ ok: true, session: provisioned });
    const deps = buildRealSandboxRunDeps();

    const result = await deps.resolveBillingSession?.({
      userId: 'u1',
      tenantId: 'u1',
      conversationId: 'conv-fresh-global',
      actorEmail: 'u1@example.com',
      tier: 'pro',
    });

    expect(result).toEqual({ sessionId: 'auto-ses-1', driveId: null, ownerId: 'u1' });
    expect(mockEnsureGlobalSandboxSession).toHaveBeenCalledWith('conv-fresh-global', 'u1');
  });

  it('given a GLOBAL conversation whose auto-provisioning hits the session cap, fails CLOSED with { deny } rather than resolving null — a concurrent sibling\'s claim could still let acquireSandbox succeed moments later, executing unmetered (review finding — P1, PR #2314, second pass)', async () => {
    mockFindSessionForConversation.mockResolvedValue(null);
    mockGetConversation.mockResolvedValue({ type: 'global' });
    mockEnsureGlobalSandboxSession.mockResolvedValue({ ok: false, reason: 'session_limit_reached' });
    const deps = buildRealSandboxRunDeps();

    const result = await deps.resolveBillingSession?.({
      userId: 'u1',
      tenantId: 'u1',
      conversationId: 'conv-fresh-global',
      actorEmail: 'u1@example.com',
      tier: 'pro',
    });

    expect(result).toEqual({ deny: 'session_limit_reached' });
  });

  it('given a GLOBAL conversation whose auto-provisioning fails with a transient spawn fault, ALSO fails CLOSED with { deny } — same reasoning as session_limit_reached: a retry (this call\'s own acquireSandbox, or a concurrent sibling) could still succeed after the transient fault clears (review finding — P1, PR #2314, third round)', async () => {
    mockFindSessionForConversation.mockResolvedValue(null);
    mockGetConversation.mockResolvedValue({ type: 'global' });
    mockEnsureGlobalSandboxSession.mockResolvedValue({ ok: false, reason: 'spawn_failed' });
    const deps = buildRealSandboxRunDeps();

    const result = await deps.resolveBillingSession?.({
      userId: 'u1',
      tenantId: 'u1',
      conversationId: 'conv-fresh-global',
      actorEmail: 'u1@example.com',
      tier: 'pro',
    });

    expect(result).toEqual({ deny: 'provision_failed' });
  });

  it('given a GLOBAL conversation whose auto-provisioning attempt lost a claim with no winner found (attempted, reason no_session), STILL fails CLOSED — attempted-and-failed is never treated as safely null, regardless of which of the three reasons it is', async () => {
    mockFindSessionForConversation.mockResolvedValue(null);
    mockGetConversation.mockResolvedValue({ type: 'global' });
    mockEnsureGlobalSandboxSession.mockResolvedValue({ ok: false, reason: 'no_session' });
    const deps = buildRealSandboxRunDeps();

    const result = await deps.resolveBillingSession?.({
      userId: 'u1',
      tenantId: 'u1',
      conversationId: 'conv-fresh-global',
      actorEmail: 'u1@example.com',
      tier: 'pro',
    });

    expect(result).toEqual({ deny: 'provision_failed' });
  });
});

describe('buildSandboxTools', () => {
  it('should return exactly the four session tools', () => {
    expect(Object.keys(buildSandboxTools()).sort()).toEqual(['bash', 'editFile', 'readFile', 'writeFile']);
  });
});
