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
  mockCheckMachineRuntimeGuardrail,
  mockRecordMachineActivity,
} = vi.hoisted(() => ({
  mockFindSessionForConversation: vi.fn(),
  mockProvisionSessionSandbox: vi.fn(),
  mockMeasureWarmSessionStorage: vi.fn(async () => {}),
  mockCheckMachineRuntimeGuardrail: vi.fn(),
  mockRecordMachineActivity: vi.fn(),
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
}));
vi.mock('@pagespace/lib/services/sandbox/quota', () => ({
  acquireCodeExecutionSlot: vi.fn(() => true),
  releaseCodeExecutionSlot: vi.fn(),
  checkMachineRuntimeGuardrail: mockCheckMachineRuntimeGuardrail,
  recordMachineActivity: mockRecordMachineActivity,
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
    mockCheckMachineRuntimeGuardrail.mockReturnValue({ allowed: true });
    mockFindSessionForConversation.mockResolvedValue(sessionRecord);
    mockProvisionSessionSandbox.mockResolvedValue({ ok: true, sandboxId: 'sbx-1', resumed: false });
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

  it('given no conversationId, should fail as provision_failed/missing_conversation_id without touching the session runtime', async () => {
    const deps = buildRealSandboxRunDeps();
    const result = await deps.acquireSandbox(baseInput({ conversationId: undefined }));
    expect(result).toEqual({ ok: false, reason: 'provision_failed', cause: 'missing_conversation_id' });
    expect(mockFindSessionForConversation).not.toHaveBeenCalled();
    expect(mockProvisionSessionSandbox).not.toHaveBeenCalled();
    expect(mockCheckMachineRuntimeGuardrail).not.toHaveBeenCalled();
  });

  it('given the runtime guardrail denies, should short-circuit BEFORE provisioning — keyed by the SESSION id', async () => {
    mockCheckMachineRuntimeGuardrail.mockReturnValue({ allowed: false, reason: 'machine_runtime_exceeded' });
    const deps = buildRealSandboxRunDeps();
    const result = await deps.acquireSandbox(baseInput());
    expect(result).toEqual({ ok: false, reason: 'machine_runtime_exceeded' });
    // One runtime budget per WORKSPACE, however many threads work in it.
    expect(mockCheckMachineRuntimeGuardrail).toHaveBeenCalledWith({
      machineKey: 'ses-1',
      now: expect.any(Number),
    });
    expect(mockProvisionSessionSandbox).not.toHaveBeenCalled();
    expect(mockRecordMachineActivity).not.toHaveBeenCalled();
  });

  it('given a conversation with NO session, should DENY — never lazily mint a per-thread environment', async () => {
    // Per-conversation minting is exactly the conflation the session model
    // removed; it is what made panes unable to share a sandbox.
    mockFindSessionForConversation.mockResolvedValue(null);
    const deps = buildRealSandboxRunDeps();
    const result = await deps.acquireSandbox(baseInput());
    expect(result).toEqual({ ok: false, reason: 'provision_failed', cause: 'no_session' });
    expect(mockProvisionSessionSandbox).not.toHaveBeenCalled();
    expect(mockRecordMachineActivity).not.toHaveBeenCalled();
  });

  it('given two conversations bound to ONE session, both should acquire the SAME sandbox', async () => {
    // R0's payoff test at the tool layer: sandbox sharing is structural. Both
    // threads resolve one session row, and provisioning folds ITS id — so both
    // acquisitions name one sandboxId with no shared id threaded anywhere.
    mockProvisionSessionSandbox.mockResolvedValue({ ok: true, sandboxId: 'sbx-shared', resumed: true });
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
    expect(mockRecordMachineActivity).not.toHaveBeenCalled();
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
    mockProvisionSessionSandbox.mockResolvedValue({ ok: true, sandboxId: 'sbx-1', resumed: true });
    const deps = buildRealSandboxRunDeps();
    const result = await deps.acquireSandbox(baseInput());
    expect(result).toEqual({ ok: true, sandboxId: 'sbx-1', resumed: true, pageId: 'agent-1' });
    expect(mockFindSessionForConversation).toHaveBeenCalledWith('conv-1');
    expect(mockProvisionSessionSandbox).toHaveBeenCalledWith(sessionRecord, 'u1');
    expect(mockRecordMachineActivity).toHaveBeenCalledWith({
      machineKey: 'ses-1',
      now: expect.any(Number),
    });
  });

  it('given no agentPageId (a global-assistant conversation), should return no pageId', async () => {
    const deps = buildRealSandboxRunDeps();
    const result = await deps.acquireSandbox(baseInput({ agentPageId: undefined, driveId: undefined }));
    expect(result).toEqual({ ok: true, sandboxId: 'sbx-1', resumed: false, pageId: undefined });
    expect(mockFindSessionForConversation).toHaveBeenCalledWith('conv-1');
  });
});

describe('buildSandboxTools', () => {
  it('should return exactly the four session tools', () => {
    expect(Object.keys(buildSandboxTools()).sort()).toEqual(['bash', 'editFile', 'readFile', 'writeFile']);
  });
});
