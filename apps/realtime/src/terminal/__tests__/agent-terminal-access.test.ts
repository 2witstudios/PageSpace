import { describe, it, vi } from 'vitest';
import { assert } from './riteway';
import type { SpriteInstanceLike } from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import type { ResolveAgentTerminalResult } from '@pagespace/lib/services/machines/agent-terminals';
import {
  decideAgentTerminalAccess,
  resolveMachineSandbox,
  buildAgentTerminalCheckAuth,
  type AgentTerminalAccessInputs,
  type ResolveMachineSandboxDeps,
  type AgentTerminalCheckAuthDeps,
} from '../agent-terminal-access';

// A minimal, identity-carrying stand-in for a real Sprite instance — the access
// layer only ever passes it through, never calls it.
const fakeSprite = { name: 'sprite-under-test' } as unknown as SpriteInstanceLike;

// ---------------------------------------------------------------------------
// decideAgentTerminalAccess — pure, exhaustive, NO mocks
// ---------------------------------------------------------------------------

const happyInputs: AgentTerminalAccessInputs = {
  access: { canEdit: true },
  pageRow: { driveId: 'drive-1' },
  codeAuth: { ok: true },
  driveRow: { ownerId: 'payer-1' },
  slotAcquired: true,
};

describe('decideAgentTerminalAccess', () => {
  it('denies when there is no access level at all', () => {
    assert({
      given: 'a null access level',
      should: 'deny with no_edit_access',
      actual: decideAgentTerminalAccess({ ...happyInputs, access: null }),
      expected: { allow: false, reason: 'no_edit_access' },
    });
  });

  it('denies when the access level lacks edit rights', () => {
    assert({
      given: 'an access level with canEdit=false',
      should: 'deny with no_edit_access',
      actual: decideAgentTerminalAccess({ ...happyInputs, access: { canEdit: false } }),
      expected: { allow: false, reason: 'no_edit_access' },
    });
  });

  it('denies when the machine page row is missing', () => {
    assert({
      given: 'no page row',
      should: 'deny with page_not_found',
      actual: decideAgentTerminalAccess({ ...happyInputs, pageRow: null }),
      expected: { allow: false, reason: 'page_not_found' },
    });
  });

  it('denies with the canRunCode reason when code execution is not permitted', () => {
    assert({
      given: 'a canRunCode denial',
      should: 'surface that denial reason verbatim',
      actual: decideAgentTerminalAccess({
        ...happyInputs,
        codeAuth: { ok: false, reason: 'code_execution_disabled' },
      }),
      expected: { allow: false, reason: 'code_execution_disabled' },
    });
  });

  it('denies when the owning drive row is missing', () => {
    assert({
      given: 'no drive row',
      should: 'deny with drive_not_found',
      actual: decideAgentTerminalAccess({ ...happyInputs, driveRow: null }),
      expected: { allow: false, reason: 'drive_not_found' },
    });
  });

  it('denies when the concurrency slot could not be acquired', () => {
    assert({
      given: 'billing-slot exhaustion (slotAcquired=false)',
      should: 'deny with concurrency_limit',
      actual: decideAgentTerminalAccess({ ...happyInputs, slotAcquired: false }),
      expected: { allow: false, reason: 'concurrency_limit' },
    });
  });

  it('allows and surfaces the derived driveId + payerId on the happy path', () => {
    assert({
      given: 'all gates satisfied',
      should: 'allow and expose the resolved driveId and payerId',
      actual: decideAgentTerminalAccess(happyInputs),
      expected: { allow: true, driveId: 'drive-1', payerId: 'payer-1' },
    });
  });

  it('checks edit access BEFORE the page row (ordering preserved)', () => {
    assert({
      given: 'both no edit access AND a missing page row',
      should: 'report the earliest gate (no_edit_access)',
      actual: decideAgentTerminalAccess({ ...happyInputs, access: null, pageRow: null }),
      expected: { allow: false, reason: 'no_edit_access' },
    });
  });
});

// ---------------------------------------------------------------------------
// resolveMachineSandbox — narrow integration with injected fakes
// ---------------------------------------------------------------------------

const resolvedOk: ResolveAgentTerminalResult = {
  ok: true,
  agentTerminalId: 'at-1',
  sandboxId: 'sbx-1',
  cwd: '/home/machine',
  agentType: 'shell',
  command: null,
  streamSessionId: null,
};

function spyGetSprite(impl?: (sandboxId: string) => Promise<SpriteInstanceLike>) {
  const calls: string[] = [];
  const fn = async (sandboxId: string): Promise<SpriteInstanceLike> => {
    calls.push(sandboxId);
    if (impl) return impl(sandboxId);
    return fakeSprite;
  };
  return { fn, calls };
}

describe('resolveMachineSandbox', () => {
  it('resolves the sandbox and reads the Sprite exactly once on the happy path', async () => {
    const getSprite = spyGetSprite();
    const deps: ResolveMachineSandboxDeps = {
      resolveAgentTerminal: async () => resolvedOk,
      getSprite: getSprite.fn,
    };

    const result = await resolveMachineSandbox({ machineId: 'm-1', name: 'shell' }, deps);

    assert({
      given: 'a resolvable agent terminal',
      should: 'return the launch spec, cwd and sprite for a fresh PTY',
      actual: result,
      expected: {
        ok: true,
        agentTerminalId: 'at-1',
        sandboxId: 'sbx-1',
        cwd: '/home/machine',
        command: 'shell',
        args: [],
        commandOverride: null,
        streamSessionId: null,
        sprite: fakeSprite,
      },
    });
  });

  it('calls getSprite exactly once (single sprite resolution)', async () => {
    const getSprite = spyGetSprite();
    await resolveMachineSandbox(
      { machineId: 'm-1', name: 'shell' },
      { resolveAgentTerminal: async () => resolvedOk, getSprite: getSprite.fn },
    );

    assert({
      given: 'a successful sandbox resolution',
      should: 'read the Sprite exactly once',
      actual: getSprite.calls.length,
      expected: 1,
    });
  });

  it('surfaces a per-terminal command override as commandOverride', async () => {
    const result = await resolveMachineSandbox(
      { machineId: 'm-1', name: 'runner' },
      {
        resolveAgentTerminal: async () => ({ ...resolvedOk, agentType: 'shell', command: 'htop --tree' }),
        getSprite: spyGetSprite().fn,
      },
    );

    assert({
      given: 'a resolved row with a command override',
      should: 'expose the override plus the agentType launch command',
      actual: result.ok ? { command: result.command, commandOverride: result.commandOverride } : result,
      expected: { command: 'shell', commandOverride: 'htop --tree' },
    });
  });

  it('performs zero sprite reads when the agent terminal does not resolve', async () => {
    const getSprite = spyGetSprite();
    const result = await resolveMachineSandbox(
      { machineId: 'm-1', name: 'ghost' },
      { resolveAgentTerminal: async () => ({ ok: false, reason: 'not_found' }), getSprite: getSprite.fn },
    );

    assert({
      given: 'an unresolvable agent terminal',
      should: 'return the denial reason without touching the Sprite',
      actual: { result, spriteCalls: getSprite.calls.length },
      expected: { result: { ok: false, reason: 'not_found' }, spriteCalls: 0 },
    });
  });

  it('refuses a pagespace (chat-surface) target WITHOUT reading the Sprite', async () => {
    const getSprite = spyGetSprite();
    const result = await resolveMachineSandbox(
      { machineId: 'm-1', name: 'assistant' },
      {
        resolveAgentTerminal: async () => ({ ...resolvedOk, agentType: 'pagespace' }),
        getSprite: getSprite.fn,
      },
    );

    assert({
      given: 'a resolved agent terminal whose agentType is pagespace (chat surface, not pty)',
      should: 'deny with not_a_pty_agent without touching the Sprite',
      actual: { result, spriteCalls: getSprite.calls.length },
      expected: { result: { ok: false, reason: 'not_a_pty_agent' }, spriteCalls: 0 },
    });
  });

  it('denies with provision_failed (and the sandboxId) when the Sprite lookup throws', async () => {
    const result = await resolveMachineSandbox(
      { machineId: 'm-1', name: 'shell' },
      {
        resolveAgentTerminal: async () => resolvedOk,
        getSprite: async () => {
          throw new Error('sprite vanished');
        },
      },
    );

    assert({
      given: 'a getSprite that throws (vanished Sprite)',
      should: 'deny with provision_failed and carry the sandboxId for logging',
      actual: result,
      expected: { ok: false, reason: 'provision_failed', sandboxId: 'sbx-1' },
    });
  });

  // -------------------------------------------------------------------------
  // refreshBranchCredential — this IS the branch's real attach path (a
  // branch's agent terminal opens/reattaches through resolveMachineSandbox,
  // never through spawnBranch/attachBranch's machine-branches.ts), so it must
  // fire on every branch-scope resolution and never for machine/project scope
  // (those run ON the root Sprite, which already has its own credential).
  // -------------------------------------------------------------------------

  function spyRefresh() {
    const calls: { machineId: string; sandboxId: string }[] = [];
    const fn = async (args: { machineId: string; sandboxId: string }) => {
      calls.push(args);
    };
    return { fn, calls };
  }

  it('given a BRANCH-scope target, should refresh the branch credential with the resolved machineId and sandboxId', async () => {
    const refresh = spyRefresh();
    await resolveMachineSandbox(
      { machineId: 'm-1', projectName: 'proj', branchName: 'feature-x', name: 'claude' },
      {
        resolveAgentTerminal: async () => resolvedOk,
        getSprite: spyGetSprite().fn,
        refreshBranchCredential: refresh.fn,
      },
    );

    assert({
      given: 'a branch-scope target (projectName + branchName both set)',
      should: 'call refreshBranchCredential exactly once with the resolved machineId + sandboxId',
      actual: refresh.calls,
      expected: [{ machineId: 'm-1', sandboxId: 'sbx-1' }],
    });
  });

  it('given a MACHINE-scope target (no projectName/branchName), should NOT refresh any credential', async () => {
    const refresh = spyRefresh();
    await resolveMachineSandbox(
      { machineId: 'm-1', name: 'shell' },
      { resolveAgentTerminal: async () => resolvedOk, getSprite: spyGetSprite().fn, refreshBranchCredential: refresh.fn },
    );

    assert({
      given: 'a machine-scope target',
      should: 'never call refreshBranchCredential — the root Sprite already has its own credential',
      actual: refresh.calls.length,
      expected: 0,
    });
  });

  it('given a PROJECT-scope target (projectName set, no branchName), should NOT refresh any credential', async () => {
    const refresh = spyRefresh();
    await resolveMachineSandbox(
      { machineId: 'm-1', projectName: 'proj', name: 'shell' },
      { resolveAgentTerminal: async () => resolvedOk, getSprite: spyGetSprite().fn, refreshBranchCredential: refresh.fn },
    );

    assert({
      given: 'a project-scope target',
      should: 'never call refreshBranchCredential — project scope shares the root Sprite too',
      actual: refresh.calls.length,
      expected: 0,
    });
  });

  it('given branchName set WITHOUT projectName (malformed — a real resolveAgentTerminal would reject this as invalid_target before ever reaching here), should still NOT refresh any credential even against a permissive fake resolver', async () => {
    // A real `resolveAgentTerminal` (agent-terminals.ts) already rejects this
    // shape as `invalid_target` before Sprite resolution — but this test's
    // fake resolver deliberately does NOT enforce that, to prove the gate
    // itself checks BOTH projectName and branchName rather than relying on
    // that upstream invariant alone.
    const refresh = spyRefresh();
    await resolveMachineSandbox(
      { machineId: 'm-1', branchName: 'feature-x', name: 'claude' },
      { resolveAgentTerminal: async () => resolvedOk, getSprite: spyGetSprite().fn, refreshBranchCredential: refresh.fn },
    );

    assert({
      given: 'a branchName-only target reaching a permissive fake resolver',
      should: 'never call refreshBranchCredential — the gate requires projectName too, not branchName alone',
      actual: refresh.calls.length,
      expected: 0,
    });
  });

  it('given a branch-scope target with refreshBranchCredential OMITTED, should still resolve successfully', async () => {
    const result = await resolveMachineSandbox(
      { machineId: 'm-1', projectName: 'proj', branchName: 'feature-x', name: 'claude' },
      { resolveAgentTerminal: async () => resolvedOk, getSprite: spyGetSprite().fn },
    );

    assert({
      given: 'a branch-scope target with no refreshBranchCredential dep wired (e.g. a caller/test that omits it)',
      should: 'resolve ok regardless — the dep is optional',
      actual: result.ok,
      expected: true,
    });
  });

  it('given refreshBranchCredential throws, should still resolve successfully (defense in depth)', async () => {
    const result = await resolveMachineSandbox(
      { machineId: 'm-1', projectName: 'proj', branchName: 'feature-x', name: 'claude' },
      {
        resolveAgentTerminal: async () => resolvedOk,
        getSprite: spyGetSprite().fn,
        refreshBranchCredential: async () => {
          throw new Error('root Sprite unreachable');
        },
      },
    );

    assert({
      given: 'a refreshBranchCredential implementation that violates its best-effort contract by throwing',
      should: 'still resolve ok — the PTY open must never fail over a credential refresh hiccup',
      actual: result.ok,
      expected: true,
    });
  });

  it('given a refresh that never settles (a stuck root or branch Sprite), should resolve once the bound elapses rather than hanging forever', async () => {
    vi.useFakeTimers();
    try {
      const pending = resolveMachineSandbox(
        { machineId: 'm-1', projectName: 'proj', branchName: 'feature-x', name: 'claude' },
        {
          resolveAgentTerminal: async () => resolvedOk,
          getSprite: spyGetSprite().fn,
          // Never resolves — simulates a Sprite fs op that's stuck (e.g. a
          // hibernating Sprite mid wake-retry).
          refreshBranchCredential: () => new Promise<void>(() => {}),
        },
      );
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;

      assert({
        given: 'a refreshBranchCredential that never settles',
        should: 'still resolve ok once the bound elapses, not hang indefinitely',
        actual: result.ok,
        expected: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// buildAgentTerminalCheckAuth — narrow integration with injected fakes
// ---------------------------------------------------------------------------

type SandboxSpy = {
  fn: AgentTerminalCheckAuthDeps['resolveSandbox'];
  calls: number;
  getSpriteCalls: string[];
};

/** A resolveSandbox wired through the REAL resolveMachineSandbox so a spy
 * getSprite records whether the sprite SDK was touched at all. */
function sandboxSpy(resolve: () => Promise<ResolveAgentTerminalResult>): SandboxSpy {
  const spy: SandboxSpy = { fn: async () => ({ ok: false, reason: 'unset' }), calls: 0, getSpriteCalls: [] };
  spy.fn = async ({ machineId, projectName, branchName, name }) => {
    spy.calls += 1;
    return resolveMachineSandbox(
      { machineId, projectName, branchName, name },
      {
        resolveAgentTerminal: resolve,
        getSprite: async (sandboxId) => {
          spy.getSpriteCalls.push(sandboxId);
          return fakeSprite;
        },
      },
    );
  };
  return spy;
}

type DepCalls = { getPageDriveId: number; canRunCode: number; getDriveAndUser: number; resolveMachineRow: number };

/** Default deps whose read functions COUNT their own invocations, so a
 * short-circuit test can assert "this table was never queried" via `calls`
 * without defining a never-called override arrow (which would count against
 * function coverage). Overrides replace a default entirely. */
function buildDeps(overrides: Partial<AgentTerminalCheckAuthDeps> = {}): {
  deps: AgentTerminalCheckAuthDeps;
  calls: DepCalls;
} {
  const calls: DepCalls = { getPageDriveId: 0, canRunCode: 0, getDriveAndUser: 0, resolveMachineRow: 0 };
  const base: AgentTerminalCheckAuthDeps = {
    getAccessLevel: async () => ({ canEdit: true }),
    getPageDriveId: async () => {
      calls.getPageDriveId += 1;
      return { driveId: 'drive-1' };
    },
    canRunCode: async () => {
      calls.canRunCode += 1;
      return { ok: true };
    },
    getDriveAndUser: async () => {
      calls.getDriveAndUser += 1;
      return { driveRow: { ownerId: 'payer-1' }, userRow: { subscriptionTier: 'pro', email: 'a@b.c' } };
    },
    resolveActorEmail: async (email) => email ?? '',
    acquireSlot: () => true,
    releaseSlot: () => {},
    resolveSandbox: async () => ({
      ok: true,
      agentTerminalId: 'at-1',
      sandboxId: 'sbx-1',
      cwd: '/home/machine',
      command: 'shell',
      args: [],
      commandOverride: null,
      streamSessionId: null,
      sprite: fakeSprite,
    }),
    resolveMachineRow: async () => {
      calls.resolveMachineRow += 1;
      return { ok: true, agentType: 'shell' };
    },
    writeAudit: () => {},
    buildSessionKey: () => 'session-key-1',
    logDenied: () => {},
    logSandboxLookupFailed: () => {},
  };
  return { deps: { ...base, ...overrides }, calls };
}

describe('buildAgentTerminalCheckAuth', () => {
  it('denies access WITHOUT any sprite SDK call when the user lacks edit rights', async () => {
    const sandbox = sandboxSpy(async () => resolvedOk);
    const { deps } = buildDeps({ getAccessLevel: async () => null, resolveSandbox: sandbox.fn });
    const checkAuth = buildAgentTerminalCheckAuth(deps);

    const result = await checkAuth({ userId: 'u-1', machineId: 'm-1', name: 'shell' });

    assert({
      given: 'a user with no edit access',
      should: 'deny with no_edit_access and never resolve or read a Sprite',
      actual: { result, sandboxCalls: sandbox.calls, spriteCalls: sandbox.getSpriteCalls.length },
      expected: { result: { ok: false, reason: 'no_edit_access' }, sandboxCalls: 0, spriteCalls: 0 },
    });
  });

  it('denies with page_not_found (skipping canRunCode + drive lookup) when the machine page is missing', async () => {
    const sandbox = sandboxSpy(async () => resolvedOk);
    const { deps, calls } = buildDeps({
      getPageDriveId: async () => undefined,
      resolveSandbox: sandbox.fn,
    });
    const checkAuth = buildAgentTerminalCheckAuth(deps);

    const result = await checkAuth({ userId: 'u-1', machineId: 'm-1', name: 'shell' });

    assert({
      given: 'a missing machine page row',
      should: 'deny with page_not_found without probing canRunCode, the drive, or a Sprite',
      actual: { result, canRunCodeCalls: calls.canRunCode, driveLookups: calls.getDriveAndUser, spriteCalls: sandbox.getSpriteCalls.length },
      expected: { result: { ok: false, reason: 'page_not_found' }, canRunCodeCalls: 0, driveLookups: 0, spriteCalls: 0 },
    });
  });

  it('releases the slot and logs a plain denial when sandbox resolution fails for a non-provision reason', async () => {
    let releases = 0;
    const denials: Array<{ reason: string }> = [];
    const { deps } = buildDeps({
      releaseSlot: () => {
        releases += 1;
      },
      resolveSandbox: async () => ({ ok: false, reason: 'not_found' }),
      logDenied: (reason) => {
        denials.push({ reason });
      },
    });
    const checkAuth = buildAgentTerminalCheckAuth(deps);

    const auth = await checkAuth({ userId: 'u-1', machineId: 'm-1', name: 'ghost' });
    const result = auth.ok ? await auth.resolveSandbox() : auth;

    assert({
      given: 'a read-only sandbox resolution denial (not_found) after the slot was reserved',
      should: 'release the slot, log the denial, and return the reason',
      actual: { result, releases, denials },
      expected: { result: { ok: false, reason: 'not_found' }, releases: 1, denials: [{ reason: 'not_found' }] },
    });
  });

  it('performs ZERO sandbox resolution and writes NO audit row when the caller never resolves the sandbox (the reattach path)', async () => {
    const sandbox = sandboxSpy(async () => resolvedOk);
    const audits: string[] = [];
    const { deps } = buildDeps({
      resolveSandbox: sandbox.fn,
      writeAudit: ({ command }) => {
        audits.push(command);
      },
    });
    const checkAuth = buildAgentTerminalCheckAuth(deps);

    // Exactly what onConnect does when it finds a live in-memory session: it
    // authorizes, takes the sessionKey, and never calls resolveSandbox.
    const auth = await checkAuth({ userId: 'u-1', machineId: 'm-1', name: 'shell' });

    assert({
      given: 'an authorized connect whose caller reattaches instead of creating',
      should: 'authorize with a session key while touching no Sprite and writing no audit row',
      actual: {
        ok: auth.ok,
        sessionKey: auth.ok ? auth.sessionKey : null,
        sandboxCalls: sandbox.calls,
        spriteCalls: sandbox.getSpriteCalls.length,
        audits,
      },
      expected: { ok: true, sessionKey: 'session-key-1', sandboxCalls: 0, spriteCalls: 0, audits: [] },
    });
  });

  it('short-circuits on a code-execution denial WITHOUT querying drives/users (a clean deny cannot be corrupted by a downstream DB error)', async () => {
    const { deps, calls } = buildDeps({
      canRunCode: async () => ({ ok: false, reason: 'code_execution_disabled' }),
    });
    const checkAuth = buildAgentTerminalCheckAuth(deps);

    const result = await checkAuth({ userId: 'u-1', machineId: 'm-1', name: 'shell' });

    assert({
      given: 'a code_execution_disabled denial',
      should: 'return that clean denial without touching the drive/user tables',
      actual: { result, driveLookups: calls.getDriveAndUser },
      expected: { result: { ok: false, reason: 'code_execution_disabled' }, driveLookups: 0 },
    });
  });

  it('does not read the machine page when the user lacks edit access (short-circuit)', async () => {
    const { deps, calls } = buildDeps({ getAccessLevel: async () => ({ canEdit: false }) });
    const checkAuth = buildAgentTerminalCheckAuth(deps);

    const result = await checkAuth({ userId: 'u-1', machineId: 'm-1', name: 'shell' });

    assert({
      given: 'a user without edit access',
      should: 'deny with no_edit_access without reading the page row',
      actual: { result, pageReads: calls.getPageDriveId },
      expected: { result: { ok: false, reason: 'no_edit_access' }, pageReads: 0 },
    });
  });

  it('returns the access verdict (session key + payer) on the happy path', async () => {
    const { deps } = buildDeps();
    const checkAuth = buildAgentTerminalCheckAuth(deps);

    const result = await checkAuth({ userId: 'u-1', machineId: 'm-1', name: 'shell' });

    assert({
      given: 'a fully-authorized connect',
      should: 'return ok with the session key and payer, plus a sandbox resolver to call lazily',
      actual: result.ok
        ? { ok: result.ok, sessionKey: result.sessionKey, payerId: result.payerId, resolver: typeof result.resolveSandbox }
        : result,
      expected: { ok: true, sessionKey: 'session-key-1', payerId: 'payer-1', resolver: 'function' },
    });
  });

  it('resolves the full sandbox (sprite + launch spec) when the cold path calls resolveSandbox', async () => {
    const { deps } = buildDeps();
    const checkAuth = buildAgentTerminalCheckAuth(deps);

    const auth = await checkAuth({ userId: 'u-1', machineId: 'm-1', name: 'shell' });
    const sandbox = auth.ok ? await auth.resolveSandbox() : auth;

    assert({
      given: 'an authorized connect whose caller must create a fresh PTY',
      should: 'resolve the agent terminal, sprite, cwd and launch spec',
      actual: sandbox.ok
        ? {
            ok: sandbox.ok,
            agentTerminalId: sandbox.agentTerminalId,
            sandboxId: sandbox.sandboxId,
            cwd: sandbox.cwd,
            sprite: sandbox.sprite,
            command: sandbox.command,
            args: sandbox.args,
            commandOverride: sandbox.commandOverride,
            streamSessionId: sandbox.streamSessionId,
          }
        : sandbox,
      expected: {
        ok: true,
        agentTerminalId: 'at-1',
        sandboxId: 'sbx-1',
        cwd: '/home/machine',
        sprite: fakeSprite,
        command: 'shell',
        args: [],
        commandOverride: null,
        streamSessionId: null,
      },
    });
  });

  it('defaults the tier to free and the actor email to empty when the user row is absent', async () => {
    let acquiredTier: string | undefined;
    let emailInput: string | null | undefined = 'unset';
    const { deps } = buildDeps({
      getDriveAndUser: async () => ({ driveRow: { ownerId: 'payer-1' }, userRow: undefined }),
      acquireSlot: ({ tier }) => {
        acquiredTier = tier;
        return true;
      },
      resolveActorEmail: async (email) => {
        emailInput = email;
        return email ?? '';
      },
    });
    const checkAuth = buildAgentTerminalCheckAuth(deps);

    const result = await checkAuth({ userId: 'u-1', machineId: 'm-1', name: 'shell' });
    // The tier is only consulted where the slot is actually reserved — the
    // create path — so drive the thunk to observe it.
    if (result.ok) await result.resolveSandbox();

    assert({
      given: 'an authorized connect whose user row is missing',
      should: "still authorize, defaulting tier to 'free' and email to undefined→''",
      actual: { ok: result.ok, acquiredTier, emailInput },
      expected: { ok: true, acquiredTier: 'free', emailInput: undefined },
    });
  });

  it('denies with concurrency_limit and reads no Sprite when the slot is exhausted on the CREATE path', async () => {
    const sandbox = sandboxSpy(async () => resolvedOk);
    const { deps } = buildDeps({ acquireSlot: () => false, resolveSandbox: sandbox.fn });
    const checkAuth = buildAgentTerminalCheckAuth(deps);

    const auth = await checkAuth({ userId: 'u-1', machineId: 'm-1', name: 'shell' });
    const result = auth.ok ? await auth.resolveSandbox() : auth;

    assert({
      given: 'an exhausted concurrency slot on a connect that must create a fresh PTY',
      should: 'deny with concurrency_limit without resolving a Sprite',
      actual: { result, spriteCalls: sandbox.getSpriteCalls.length },
      expected: { result: { ok: false, reason: 'concurrency_limit' }, spriteCalls: 0 },
    });
  });

  it('AUTHORIZES a connect whose concurrency slots are all consumed, so long as the caller does not create a PTY', async () => {
    // The regression this guards: the slot used to be reserved by the access
    // check itself. A free-tier user (limit 1) whose ONE live session already
    // held the only slot therefore could not (a) tab back to that session — the
    // reattach's access check was denied `concurrency_limit` — nor (b) survive
    // the 60s re-auth tick, which read the same denial as a REVOKED
    // authorization and tore the live session down. Neither path starts a PTY,
    // so neither may depend on a free slot.
    let acquires = 0;
    const { deps } = buildDeps({
      acquireSlot: () => {
        acquires += 1;
        return false; // every slot is taken — by this user's own live session
      },
    });
    const checkAuth = buildAgentTerminalCheckAuth(deps);

    const auth = await checkAuth({ userId: 'u-1', machineId: 'm-1', name: 'shell' });

    assert({
      given: 'a reattach/re-auth check by a user with no free concurrency slot',
      should: 'still authorize, and never even attempt to reserve a slot',
      actual: { ok: auth.ok, sessionKey: auth.ok ? auth.sessionKey : null, acquires },
      expected: { ok: true, sessionKey: 'session-key-1', acquires: 0 },
    });
  });

  it('surfaces releaseSlot on the RESOLVED sandbox (the only path that reserves one)', async () => {
    let releases = 0;
    const { deps } = buildDeps({
      releaseSlot: () => {
        releases += 1;
      },
    });
    const checkAuth = buildAgentTerminalCheckAuth(deps);

    const auth = await checkAuth({ userId: 'u-1', machineId: 'm-1', name: 'shell' });
    const sandbox = auth.ok ? await auth.resolveSandbox() : auth;
    if (sandbox.ok) sandbox.releaseSlot();

    assert({
      given: 'a successfully resolved sandbox whose caller releases the slot it reserved',
      should: 'expose releaseSlot on the sandbox result and release exactly the one slot taken',
      actual: { hasRelease: sandbox.ok ? typeof sandbox.releaseSlot : null, releases },
      expected: { hasRelease: 'function', releases: 1 },
    });
  });

  it('releases the slot and routes provision_failed to the sandbox-lookup logger (with sandboxId)', async () => {
    let releases = 0;
    const sandboxLookupFailures: Array<Record<string, unknown>> = [];
    const denials: string[] = [];
    const { deps } = buildDeps({
      releaseSlot: () => {
        releases += 1;
      },
      resolveSandbox: async () => ({ ok: false, reason: 'provision_failed', sandboxId: 'sbx-1' }),
      logSandboxLookupFailed: (ctx) => {
        sandboxLookupFailures.push(ctx);
      },
      logDenied: (reason) => {
        denials.push(reason);
      },
    });
    const checkAuth = buildAgentTerminalCheckAuth(deps);

    const auth = await checkAuth({ userId: 'u-1', machineId: 'm-1', name: 'shell' });
    const result = auth.ok ? await auth.resolveSandbox() : auth;

    assert({
      given: 'a vanished-Sprite (provision_failed) sandbox result after the slot was reserved',
      should: 'release the slot and log via logSandboxLookupFailed with the sandboxId, NOT logDenied',
      actual: { result, releases, sandboxLookupFailures, denials },
      expected: {
        result: { ok: false, reason: 'provision_failed' },
        releases: 1,
        sandboxLookupFailures: [{ userId: 'u-1', sandboxId: 'sbx-1' }],
        denials: [],
      },
    });
  });

  it('releases the reserved slot and re-throws when sandbox resolution REJECTS', async () => {
    let releases = 0;
    const boom = new Error('db blip during resolveAgentTerminal');
    const { deps } = buildDeps({
      releaseSlot: () => {
        releases += 1;
      },
      resolveSandbox: async () => {
        throw boom;
      },
    });
    const checkAuth = buildAgentTerminalCheckAuth(deps);

    let thrown: unknown;
    try {
      const auth = await checkAuth({ userId: 'u-1', machineId: 'm-1', name: 'shell' });
      if (auth.ok) await auth.resolveSandbox();
    } catch (error) {
      thrown = error;
    }

    assert({
      given: 'a resolveSandbox that rejects after the slot was reserved',
      should: 'release the slot and propagate the original error (unchanged socket surface)',
      actual: { releases, thrown },
      expected: { releases: 1, thrown: boom },
    });
  });

  it('DENIES when the terminal\'s scope row is gone, WITHOUT resolving a Sprite (so the 60s re-auth tick still notices a deleted project)', async () => {
    // The regression this guards: with the sandbox resolution made lazy, the only
    // thing that ever noticed a deleted project/branch/agent-terminal row was the
    // resolve the re-auth tick no longer performs. A project deleted out from
    // under a LIVE terminal would leave its PTY running against a scope that no
    // longer exists. The existence check is DB-only, so re-auth can afford it —
    // and it must never be answered by waking a Sprite.
    const sandbox = sandboxSpy(async () => resolvedOk);
    const denials: string[] = [];
    const { deps } = buildDeps({
      resolveSandbox: sandbox.fn,
      resolveMachineRow: async () => ({ ok: false, reason: 'project_not_found' }),
      logDenied: (reason) => {
        denials.push(reason);
      },
    });
    const checkAuth = buildAgentTerminalCheckAuth(deps);

    const result = await checkAuth({ userId: 'u-1', machineId: 'm-1', projectName: 'gone', name: 'shell' });

    assert({
      given: 'a live terminal whose project row has been deleted',
      should: 'deny with project_not_found from the ACCESS half, touching no Sprite',
      actual: { result, denials, sandboxCalls: sandbox.calls, spriteCalls: sandbox.getSpriteCalls.length },
      expected: {
        result: { ok: false, reason: 'project_not_found' },
        denials: ['project_not_found'],
        sandboxCalls: 0,
        spriteCalls: 0,
      },
    });
  });

  it('DENIES when the agent-terminal row itself is gone, without resolving a Sprite', async () => {
    const sandbox = sandboxSpy(async () => resolvedOk);
    const { deps } = buildDeps({
      resolveSandbox: sandbox.fn,
      resolveMachineRow: async () => ({ ok: false, reason: 'not_found' }),
    });
    const checkAuth = buildAgentTerminalCheckAuth(deps);

    const result = await checkAuth({ userId: 'u-1', machineId: 'm-1', name: 'ghost' });

    assert({
      given: 'an agent-terminal row that no longer exists',
      should: 'deny with not_found from the access half, touching no Sprite',
      actual: { result, spriteCalls: sandbox.getSpriteCalls.length },
      expected: { result: { ok: false, reason: 'not_found' }, spriteCalls: 0 },
    });
  });

  it('DENIES a pagespace (chat-surface) row from the ACCESS half itself, before the lazy sandbox thunk could ever acquire/wake the machine\'s Sprite', async () => {
    // This is the gap a machine/project-scope target has that a direct
    // resolveMachineSandbox() call can't see: the real resolveAgentTerminal
    // (agent-terminals.ts) resolves the Sprite's LOCATION via
    // machineSandbox.acquire — which can resume or reprovision a hibernating
    // Sprite — BEFORE it even reads the row's agentType. Gating only inside
    // resolveMachineSandbox (which only runs from the lazy resolveSandbox
    // thunk, i.e. AFTER resolveAgentTerminal has already resolved/acquired)
    // is too late for that scope. resolveMachineRow uses resolveScopeKey
    // instead, which never touches machineSandbox at all, so denying here is
    // the earliest point that's both correct and Sprite-free.
    const sandbox = sandboxSpy(async () => ({ ...resolvedOk, agentType: 'pagespace' }));
    const denials: string[] = [];
    const { deps } = buildDeps({
      resolveSandbox: sandbox.fn,
      resolveMachineRow: async () => ({ ok: true, agentType: 'pagespace' }),
      logDenied: (reason) => {
        denials.push(reason);
      },
    });
    const checkAuth = buildAgentTerminalCheckAuth(deps);

    const result = await checkAuth({ userId: 'u-1', machineId: 'm-1', name: 'assistant' });

    assert({
      given: 'a resolveMachineRow that reports a chat-surface (pagespace) agentType for a machine-scope target',
      should: 'deny with not_a_pty_agent from the access half alone, never calling resolveSandbox or touching a Sprite',
      actual: { result, denials, sandboxCalls: sandbox.calls, spriteCalls: sandbox.getSpriteCalls.length },
      expected: {
        result: { ok: false, reason: 'not_a_pty_agent' },
        denials: ['not_a_pty_agent'],
        sandboxCalls: 0,
        spriteCalls: 0,
      },
    });
  });

  it('checks the target row existence only AFTER the read-only access gates (a stranger learns nothing about which terminals exist)', async () => {
    const { deps, calls } = buildDeps({ getAccessLevel: async () => ({ canEdit: false }) });
    const checkAuth = buildAgentTerminalCheckAuth(deps);

    const result = await checkAuth({ userId: 'u-1', machineId: 'm-1', name: 'shell' });

    assert({
      given: 'a user without edit access on the owning machine',
      should: 'deny on access alone, without probing whether the named terminal exists',
      actual: { result, rowLookups: calls.resolveMachineRow },
      expected: { result: { ok: false, reason: 'no_edit_access' }, rowLookups: 0 },
    });
  });

  it('audits the resolved launch command (override preferred) on success', async () => {
    const audits: string[] = [];
    const { deps } = buildDeps({
      writeAudit: ({ command }) => {
        audits.push(command);
      },
      resolveSandbox: async () => ({
        ok: true,
        agentTerminalId: 'at-1',
        sandboxId: 'sbx-1',
        cwd: '/home/machine',
        command: 'claude',
        args: [],
        commandOverride: 'claude --print',
        streamSessionId: null,
        sprite: fakeSprite,
      }),
    });
    const checkAuth = buildAgentTerminalCheckAuth(deps);

    const auth = await checkAuth({ userId: 'u-1', machineId: 'm-1', name: 'runner' });
    if (auth.ok) await auth.resolveSandbox();

    assert({
      given: 'a resolved terminal with a command override',
      should: 'record the override in the audit line',
      actual: audits,
      expected: ['claude --print'],
    });
  });
});
