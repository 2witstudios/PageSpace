import { describe, it } from 'vitest';
import { assert } from './riteway';
import type { SpriteInstanceLike } from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import type { ResolveAgentTerminalResult } from '@pagespace/lib/services/machines/agent-terminals';
import {
  decideAgentTerminalAccess,
  resolveTerminalSandbox,
  buildAgentTerminalCheckAuth,
  type AgentTerminalAccessInputs,
  type ResolveTerminalSandboxDeps,
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
// resolveTerminalSandbox — narrow integration with injected fakes
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

describe('resolveTerminalSandbox', () => {
  it('resolves the sandbox and reads the Sprite exactly once on the happy path', async () => {
    const getSprite = spyGetSprite();
    const deps: ResolveTerminalSandboxDeps = {
      resolveAgentTerminal: async () => resolvedOk,
      getSprite: getSprite.fn,
    };

    const result = await resolveTerminalSandbox({ machineId: 'm-1', name: 'shell' }, deps);

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
    await resolveTerminalSandbox(
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
    const result = await resolveTerminalSandbox(
      { machineId: 'm-1', name: 'runner' },
      {
        resolveAgentTerminal: async () => ({ ...resolvedOk, agentType: 'claude', command: 'claude --dangerously' }),
        getSprite: spyGetSprite().fn,
      },
    );

    assert({
      given: 'a resolved row with a command override',
      should: 'expose the override plus the agentType launch command',
      actual: result.ok ? { command: result.command, commandOverride: result.commandOverride } : result,
      expected: { command: 'claude', commandOverride: 'claude --dangerously' },
    });
  });

  it('performs zero sprite reads when the agent terminal does not resolve', async () => {
    const getSprite = spyGetSprite();
    const result = await resolveTerminalSandbox(
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

  it('denies with provision_failed (and the sandboxId) when the Sprite lookup throws', async () => {
    const result = await resolveTerminalSandbox(
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
});

// ---------------------------------------------------------------------------
// buildAgentTerminalCheckAuth — narrow integration with injected fakes
// ---------------------------------------------------------------------------

type SandboxSpy = {
  fn: AgentTerminalCheckAuthDeps['resolveSandbox'];
  calls: number;
  getSpriteCalls: string[];
};

/** A resolveSandbox wired through the REAL resolveTerminalSandbox so a spy
 * getSprite records whether the sprite SDK was touched at all. */
function sandboxSpy(resolve: () => Promise<ResolveAgentTerminalResult>): SandboxSpy {
  const spy: SandboxSpy = { fn: async () => ({ ok: false, reason: 'unset' }), calls: 0, getSpriteCalls: [] };
  spy.fn = async ({ machineId, projectName, branchName, name }) => {
    spy.calls += 1;
    return resolveTerminalSandbox(
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

function buildDeps(overrides: Partial<AgentTerminalCheckAuthDeps> = {}): { deps: AgentTerminalCheckAuthDeps } {
  const base: AgentTerminalCheckAuthDeps = {
    getAccessLevel: async () => ({ canEdit: true }),
    getPageDriveId: async () => ({ driveId: 'drive-1' }),
    canRunCode: async () => ({ ok: true }),
    getDriveAndUser: async () => ({ driveRow: { ownerId: 'payer-1' }, userRow: { subscriptionTier: 'pro', email: 'a@b.c' } }),
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
    writeAudit: () => {},
    buildSessionKey: () => 'session-key-1',
    logDenied: () => {},
    logSandboxLookupFailed: () => {},
  };
  return { deps: { ...base, ...overrides } };
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
    let canRunCodeCalls = 0;
    let driveLookups = 0;
    const { deps } = buildDeps({
      getPageDriveId: async () => undefined,
      canRunCode: async () => {
        canRunCodeCalls += 1;
        return { ok: true };
      },
      getDriveAndUser: async () => {
        driveLookups += 1;
        return { driveRow: { ownerId: 'payer-1' }, userRow: undefined };
      },
      resolveSandbox: sandbox.fn,
    });
    const checkAuth = buildAgentTerminalCheckAuth(deps);

    const result = await checkAuth({ userId: 'u-1', machineId: 'm-1', name: 'shell' });

    assert({
      given: 'a missing machine page row',
      should: 'deny with page_not_found without probing canRunCode, the drive, or a Sprite',
      actual: { result, canRunCodeCalls, driveLookups, spriteCalls: sandbox.getSpriteCalls.length },
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

    const result = await checkAuth({ userId: 'u-1', machineId: 'm-1', name: 'ghost' });

    assert({
      given: 'a read-only sandbox resolution denial (not_found) after the slot was reserved',
      should: 'release the slot, log the denial, and return the reason',
      actual: { result, releases, denials },
      expected: { result: { ok: false, reason: 'not_found' }, releases: 1, denials: [{ reason: 'not_found' }] },
    });
  });

  it('returns a fully-populated authorization on the happy path', async () => {
    const { deps } = buildDeps();
    const checkAuth = buildAgentTerminalCheckAuth(deps);

    const result = await checkAuth({ userId: 'u-1', machineId: 'm-1', name: 'shell' });

    assert({
      given: 'a fully-authorized connect',
      should: 'return ok with the sandbox, session key and payer',
      actual: result.ok
        ? {
            ok: result.ok,
            agentTerminalId: result.agentTerminalId,
            sandboxId: result.sandboxId,
            cwd: result.cwd,
            sessionKey: result.sessionKey,
            command: result.command,
            args: result.args,
            commandOverride: result.commandOverride,
            streamSessionId: result.streamSessionId,
            payerId: result.payerId,
            sprite: result.sprite,
          }
        : result,
      expected: {
        ok: true,
        agentTerminalId: 'at-1',
        sandboxId: 'sbx-1',
        cwd: '/home/machine',
        sessionKey: 'session-key-1',
        command: 'shell',
        args: [],
        commandOverride: null,
        streamSessionId: null,
        payerId: 'payer-1',
        sprite: fakeSprite,
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

    assert({
      given: 'an authorized connect whose user row is missing',
      should: "still authorize, defaulting tier to 'free' and email to undefined→''",
      actual: { ok: result.ok, acquiredTier, emailInput },
      expected: { ok: true, acquiredTier: 'free', emailInput: undefined },
    });
  });

  it('denies with concurrency_limit and reads no Sprite when the slot is exhausted', async () => {
    const sandbox = sandboxSpy(async () => resolvedOk);
    const { deps } = buildDeps({ acquireSlot: () => false, resolveSandbox: sandbox.fn });
    const checkAuth = buildAgentTerminalCheckAuth(deps);

    const result = await checkAuth({ userId: 'u-1', machineId: 'm-1', name: 'shell' });

    assert({
      given: 'an exhausted concurrency slot',
      should: 'deny with concurrency_limit without resolving a Sprite',
      actual: { result, spriteCalls: sandbox.getSpriteCalls.length },
      expected: { result: { ok: false, reason: 'concurrency_limit' }, spriteCalls: 0 },
    });
  });

  it('releases the reserved slot when sandbox resolution fails', async () => {
    let releases = 0;
    const { deps } = buildDeps({
      releaseSlot: () => {
        releases += 1;
      },
      resolveSandbox: async () => ({ ok: false, reason: 'provision_failed', sandboxId: 'sbx-1' }),
    });
    const checkAuth = buildAgentTerminalCheckAuth(deps);

    const result = await checkAuth({ userId: 'u-1', machineId: 'm-1', name: 'shell' });

    assert({
      given: 'a sandbox resolution failure after the slot was reserved',
      should: 'return the failure reason and release the slot',
      actual: { result, releases },
      expected: { result: { ok: false, reason: 'provision_failed' }, releases: 1 },
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

    await checkAuth({ userId: 'u-1', machineId: 'm-1', name: 'runner' });

    assert({
      given: 'a resolved terminal with a command override',
      should: 'record the override in the audit line',
      actual: audits,
      expected: ['claude --print'],
    });
  });
});
