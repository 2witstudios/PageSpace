import { describe, it } from 'vitest';
import { assert } from './riteway';
import type { SpriteInstanceLike } from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import type { ShellDTO } from '@pagespace/lib/agent-workspaces/contract';
import { buildShellCheckAuth, type ShellCheckAuthDeps } from '../shell-access';

// A minimal, identity-carrying stand-in for a real Sprite instance — the access
// layer only ever passes it through, never calls it.
const fakeSprite = { name: 'sprite-under-test' } as unknown as SpriteInstanceLike;

const shellRow: ShellDTO = {
  shellId: 'shl-1',
  workspaceId: 'conv-1',
  ownerId: 'owner-1',
  name: 'shell',
  agentType: 'shell',
  command: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const sessionSubject = { workspaceId: 'ses-1', ownerId: 'owner-1', driveId: 'drive-1' };

type DepCalls = {
  checkSessionAccess: number;
  resolvePayer: number;
  ensureSessionSandbox: number;
  getSprite: number;
  getUser: number;
};

/** Default deps whose read functions COUNT their own invocations, so a
 * short-circuit test can assert "this seam was never touched" via `calls`
 * without defining a never-called override arrow. Overrides replace a default
 * entirely. */
function buildDeps(overrides: Partial<ShellCheckAuthDeps> = {}): {
  deps: ShellCheckAuthDeps;
  calls: DepCalls;
} {
  const calls: DepCalls = { checkSessionAccess: 0, resolvePayer: 0, ensureSessionSandbox: 0, getSprite: 0, getUser: 0 };
  const base: ShellCheckAuthDeps = {
    resolveShell: async () => ({ ok: true, shell: shellRow, cwd: '/home/user', spriteExecId: null }),
    checkSessionAccess: async () => {
      calls.checkSessionAccess += 1;
      return { allowed: true, session: sessionSubject };
    },
    resolvePayer: async () => {
      calls.resolvePayer += 1;
      return { payerId: 'payer-1', driveId: 'drive-1' };
    },
    getUser: async () => {
      calls.getUser += 1;
      return { subscriptionTier: 'pro', email: 'a@b.c' };
    },
    resolveActorEmail: async (email) => email ?? '',
    acquireSlot: () => true,
    releaseSlot: () => {},
    ensureSessionSandbox: async () => {
      calls.ensureSessionSandbox += 1;
      return { ok: true, sandboxId: 'sbx-1' };
    },
    getSprite: async () => {
      calls.getSprite += 1;
      return fakeSprite;
    },
    writeAudit: () => {},
    buildSessionKey: ({ shellId }) => `shell:${shellId}`,
    logDenied: () => {},
    logSandboxLookupFailed: () => {},
  };
  return { deps: { ...base, ...overrides }, calls };
}

describe('buildShellCheckAuth — access half', () => {
  it('denies with not_found when the shell row is gone, WITHOUT deciding session access (so the 60s re-auth tick notices a killed shell)', async () => {
    const denials: string[] = [];
    const { deps, calls } = buildDeps({
      resolveShell: async () => ({ ok: false, reason: 'not_found' }),
      logDenied: (reason) => {
        denials.push(reason);
      },
    });
    const checkAuth = buildShellCheckAuth(deps);

    const result = await checkAuth({ userId: 'u-1', shellId: 'ghost' });

    assert({
      given: 'a shellId whose row no longer exists',
      should: 'deny with not_found without deciding access or touching a Sprite',
      actual: { result, denials, accessCalls: calls.checkSessionAccess, spriteCalls: calls.getSprite },
      expected: { result: { ok: false, reason: 'not_found' }, denials: ['not_found'], accessCalls: 0, spriteCalls: 0 },
    });
  });

  it('denies with the session access decision reason verbatim (the ONE shared decision, not a re-implementation)', async () => {
    const denials: string[] = [];
    const { deps, calls } = buildDeps({
      checkSessionAccess: async () => ({ allowed: false, reason: 'code_execution_denied' }),
      logDenied: (reason) => {
        denials.push(reason);
      },
    });
    const checkAuth = buildShellCheckAuth(deps);

    const result = await checkAuth({ userId: 'u-1', shellId: 'shl-1' });

    assert({
      given: 'a session access denial from the shared decider',
      should: 'surface that denial reason verbatim, without provisioning or reading a Sprite',
      actual: { result, denials, ensureCalls: calls.ensureSessionSandbox, spriteCalls: calls.getSprite },
      expected: {
        result: { ok: false, reason: 'code_execution_denied' },
        denials: ['code_execution_denied'],
        ensureCalls: 0,
        spriteCalls: 0,
      },
    });
  });

  it('decides access against the session the SHELL ROW names — never a session id a client claims', async () => {
    const decidedAgainst: string[] = [];
    const { deps } = buildDeps({
      checkSessionAccess: async ({ workspaceId }) => {
        decidedAgainst.push(workspaceId);
        return { allowed: true, session: sessionSubject };
      },
    });
    const checkAuth = buildShellCheckAuth(deps);

    await checkAuth({ userId: 'u-1', shellId: 'shl-1' });

    assert({
      given: 'a connect addressed by shellId alone',
      should: "authorize against the resolved row's own workspaceId",
      actual: decidedAgainst,
      expected: ['conv-1'],
    });
  });

  it('performs ZERO sandbox work and writes NO audit row when the caller never resolves the sandbox (the reattach path)', async () => {
    const audits: string[] = [];
    const { deps, calls } = buildDeps({
      writeAudit: ({ command }) => {
        audits.push(command);
      },
    });
    const checkAuth = buildShellCheckAuth(deps);

    // Exactly what onConnect does when it finds a live in-memory session: it
    // authorizes, takes the sessionKey, and never calls resolveSandbox.
    const auth = await checkAuth({ userId: 'u-1', shellId: 'shl-1' });

    assert({
      given: 'an authorized connect whose caller reattaches instead of creating',
      should: 'authorize with a session key while provisioning nothing and writing no audit row',
      actual: {
        ok: auth.ok,
        sessionKey: auth.ok ? auth.sessionKey : null,
        ensureCalls: calls.ensureSessionSandbox,
        spriteCalls: calls.getSprite,
        audits,
      },
      expected: { ok: true, sessionKey: 'shell:shl-1', ensureCalls: 0, spriteCalls: 0, audits: [] },
    });
  });

  it('returns the access verdict (session key + payer + billing drive) on the happy path', async () => {
    const { deps } = buildDeps();
    const checkAuth = buildShellCheckAuth(deps);

    const result = await checkAuth({ userId: 'u-1', shellId: 'shl-1' });

    assert({
      given: 'a fully-authorized connect',
      should: 'return ok with the session key, payer and billing drive, plus a sandbox resolver to call lazily',
      actual: result.ok
        ? {
            ok: result.ok,
            sessionKey: result.sessionKey,
            payerId: result.payerId,
            driveId: result.driveId,
            resolver: typeof result.resolveSandbox,
          }
        : result,
      expected: { ok: true, sessionKey: 'shell:shl-1', payerId: 'payer-1', driveId: 'drive-1', resolver: 'function' },
    });
  });

  it('surfaces a null driveId (a global-assistant session) so billing attributes to the owner', async () => {
    const { deps } = buildDeps({
      checkSessionAccess: async () => ({
        allowed: true,
        session: { workspaceId: 'ses-1', ownerId: 'owner-1', driveId: null },
      }),
      resolvePayer: async () => ({ payerId: 'owner-1', driveId: null }),
    });
    const checkAuth = buildShellCheckAuth(deps);

    const result = await checkAuth({ userId: 'owner-1', shellId: 'shl-1' });

    assert({
      given: 'a global-assistant session (no agent page)',
      should: 'authorize with a null billing drive and the owner as payer',
      actual: result.ok ? { driveId: result.driveId, payerId: result.payerId } : result,
      expected: { driveId: null, payerId: 'owner-1' },
    });
  });

  it('defaults the tier to free and the actor email to empty when the user row is absent', async () => {
    let acquiredTier: string | undefined;
    let emailInput: string | null | undefined = 'unset';
    const { deps } = buildDeps({
      getUser: async () => undefined,
      acquireSlot: ({ tier }) => {
        acquiredTier = tier;
        return true;
      },
      resolveActorEmail: async (email) => {
        emailInput = email;
        return email ?? '';
      },
    });
    const checkAuth = buildShellCheckAuth(deps);

    const result = await checkAuth({ userId: 'u-1', shellId: 'shl-1' });
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

  it("reserves the slot with the PAYER's tier, not the requester's (review #2326)", async () => {
    // A free-tier collaborator opening a shell in a Pro-owned drive runs on
    // the drive owner's plan: `acquireSlot` refuses free-tier outright, so
    // handing it the requester's own tier would deny the very access the
    // payer-based sandbox eligibility just granted. The slot is still counted
    // against the REQUESTER — per-actor accounting, payer-based entitlement.
    let acquired: { userId: string; tier: string } | undefined;
    const { deps } = buildDeps({
      getUser: async (id) =>
        id === 'payer-1'
          ? { subscriptionTier: 'pro', email: 'payer@d.e' }
          : { subscriptionTier: 'free', email: 'actor@d.e' },
      acquireSlot: ({ userId, tier }) => {
        acquired = { userId, tier };
        return true;
      },
    });
    const checkAuth = buildShellCheckAuth(deps);

    const result = await checkAuth({ userId: 'u-1', shellId: 'shl-1' });
    if (result.ok) await result.resolveSandbox();

    assert({
      given: 'a free-tier requester whose session payer is Pro',
      should: "acquire the slot for the requester at the payer's tier",
      actual: acquired,
      expected: { userId: 'u-1', tier: 'pro' },
    });
  });

  it('audits with the REQUESTER’s email even when the payer is someone else', async () => {
    let auditedEmail: string | undefined;
    const { deps } = buildDeps({
      getUser: async (id) =>
        id === 'payer-1'
          ? { subscriptionTier: 'pro', email: 'payer@d.e' }
          : { subscriptionTier: 'free', email: 'actor@d.e' },
      writeAudit: ({ actorEmail }) => {
        auditedEmail = actorEmail;
      },
    });
    const checkAuth = buildShellCheckAuth(deps);

    const result = await checkAuth({ userId: 'u-1', shellId: 'shl-1' });
    if (result.ok) await result.resolveSandbox();

    assert({
      given: 'a payer distinct from the requester',
      should: "write the audit row with the requester's own email",
      actual: auditedEmail,
      expected: 'actor@d.e',
    });
  });
});

describe('buildShellCheckAuth — resolveSandbox thunk', () => {
  it('AUTHORIZES a connect whose concurrency slots are all consumed, so long as the caller does not create a PTY', async () => {
    // The regression this guards (inherited from the predecessor): the slot
    // used to be reserved by the access check itself. A free-tier user
    // (limit 1) whose ONE live session already held the only slot therefore
    // could not tab back to it, and the 60s re-auth tick read the same denial
    // as a revoked authorization and tore the live session down. Neither path
    // starts a PTY, so neither may depend on a free slot.
    let acquires = 0;
    const { deps } = buildDeps({
      acquireSlot: () => {
        acquires += 1;
        return false; // every slot is taken — by this user's own live session
      },
    });
    const checkAuth = buildShellCheckAuth(deps);

    const auth = await checkAuth({ userId: 'u-1', shellId: 'shl-1' });

    assert({
      given: 'a reattach/re-auth check by a user with no free concurrency slot',
      should: 'still authorize, and never even attempt to reserve a slot',
      actual: { ok: auth.ok, sessionKey: auth.ok ? auth.sessionKey : null, acquires },
      expected: { ok: true, sessionKey: 'shell:shl-1', acquires: 0 },
    });
  });

  it('denies with concurrency_limit and provisions nothing when the slot is exhausted on the CREATE path', async () => {
    const { deps, calls } = buildDeps({ acquireSlot: () => false });
    const checkAuth = buildShellCheckAuth(deps);

    const auth = await checkAuth({ userId: 'u-1', shellId: 'shl-1' });
    const result = auth.ok ? await auth.resolveSandbox() : auth;

    assert({
      given: 'an exhausted concurrency slot on a connect that must create a fresh PTY',
      should: 'deny with concurrency_limit without provisioning or reading a Sprite',
      actual: { result, ensureCalls: calls.ensureSessionSandbox, spriteCalls: calls.getSprite },
      expected: { result: { ok: false, reason: 'concurrency_limit' }, ensureCalls: 0, spriteCalls: 0 },
    });
  });

  it('resolves the full sandbox (sprite + launch spec + cwd) when the cold path calls resolveSandbox', async () => {
    const { deps } = buildDeps();
    const checkAuth = buildShellCheckAuth(deps);

    const auth = await checkAuth({ userId: 'u-1', shellId: 'shl-1' });
    const sandbox = auth.ok ? await auth.resolveSandbox() : auth;

    assert({
      given: 'an authorized connect whose caller must create a fresh PTY',
      should: 'ensure the session sandbox and hand back the sprite, cwd and launch spec',
      actual: sandbox.ok
        ? {
            ok: sandbox.ok,
            shellId: sandbox.shellId,
            workspaceId: sandbox.workspaceId,
            sandboxId: sandbox.sandboxId,
            cwd: sandbox.cwd,
            sprite: sandbox.sprite,
            command: sandbox.command,
            args: sandbox.args,
            commandOverride: sandbox.commandOverride,
            spriteExecId: sandbox.spriteExecId,
          }
        : sandbox,
      expected: {
        ok: true,
        shellId: 'shl-1',
        workspaceId: 'conv-1',
        sandboxId: 'sbx-1',
        cwd: '/home/user',
        sprite: fakeSprite,
        command: 'shell',
        args: [],
        commandOverride: null,
        spriteExecId: null,
      },
    });
  });

  it('reads the Sprite exactly once per cold resolution', async () => {
    const { deps, calls } = buildDeps();
    const checkAuth = buildShellCheckAuth(deps);

    const auth = await checkAuth({ userId: 'u-1', shellId: 'shl-1' });
    if (auth.ok) await auth.resolveSandbox();

    assert({
      given: 'a successful cold sandbox resolution',
      should: 'read the Sprite exactly once',
      actual: calls.getSprite,
      expected: 1,
    });
  });

  it('surfaces a per-shell command override as commandOverride while launching the agent type command', async () => {
    const { deps } = buildDeps({
      resolveShell: async () => ({
        ok: true,
        shell: { ...shellRow, command: 'htop --tree' },
        cwd: '/home/user',
        spriteExecId: 'sess-1',
      }),
    });
    const checkAuth = buildShellCheckAuth(deps);

    const auth = await checkAuth({ userId: 'u-1', shellId: 'shl-1' });
    const sandbox = auth.ok ? await auth.resolveSandbox() : auth;

    assert({
      given: 'a resolved row with a command override and a persisted stream session id',
      should: 'expose the override plus the agentType launch command and the stored id',
      actual: sandbox.ok
        ? { command: sandbox.command, commandOverride: sandbox.commandOverride, spriteExecId: sandbox.spriteExecId }
        : sandbox,
      expected: { command: 'shell', commandOverride: 'htop --tree', spriteExecId: 'sess-1' },
    });
  });

  it('releases the slot and logs a plain denial when the shared provisioner refuses', async () => {
    let releases = 0;
    const denials: string[] = [];
    const { deps, calls } = buildDeps({
      releaseSlot: () => {
        releases += 1;
      },
      ensureSessionSandbox: async () => ({ ok: false, reason: 'egress_denied' }),
      logDenied: (reason) => {
        denials.push(reason);
      },
    });
    const checkAuth = buildShellCheckAuth(deps);

    const auth = await checkAuth({ userId: 'u-1', shellId: 'shl-1' });
    const result = auth.ok ? await auth.resolveSandbox() : auth;

    assert({
      given: 'a shared-provisioner denial (egress_denied) after the slot was reserved',
      should: 'release the slot, log the denial, return the reason, and never read a Sprite',
      actual: { result, releases, denials, spriteCalls: calls.getSprite },
      expected: {
        result: { ok: false, reason: 'egress_denied' },
        releases: 1,
        denials: ['egress_denied'],
        spriteCalls: 0,
      },
    });
  });

  it('releases the slot and routes a vanished Sprite to the sandbox-lookup logger (with sandboxId)', async () => {
    let releases = 0;
    const sandboxLookupFailures: Array<Record<string, unknown>> = [];
    const denials: string[] = [];
    const { deps } = buildDeps({
      releaseSlot: () => {
        releases += 1;
      },
      getSprite: async () => {
        throw new Error('sprite vanished');
      },
      logSandboxLookupFailed: (ctx) => {
        sandboxLookupFailures.push(ctx);
      },
      logDenied: (reason) => {
        denials.push(reason);
      },
    });
    const checkAuth = buildShellCheckAuth(deps);

    const auth = await checkAuth({ userId: 'u-1', shellId: 'shl-1' });
    const result = auth.ok ? await auth.resolveSandbox() : auth;

    assert({
      given: 'a getSprite that throws (vanished Sprite) after the slot was reserved',
      should: 'release the slot and log via logSandboxLookupFailed with the sandboxId, NOT logDenied',
      actual: { result, releases, sandboxLookupFailures, denials },
      expected: {
        result: { ok: false, reason: 'provision_failed', sandboxId: 'sbx-1' },
        releases: 1,
        sandboxLookupFailures: [{ userId: 'u-1', sandboxId: 'sbx-1' }],
        denials: [],
      },
    });
  });

  it('releases the reserved slot and re-throws when the shared provisioner REJECTS', async () => {
    let releases = 0;
    const boom = new Error('db blip during ensureAgentSessionSandbox');
    const { deps } = buildDeps({
      releaseSlot: () => {
        releases += 1;
      },
      ensureSessionSandbox: async () => {
        throw boom;
      },
    });
    const checkAuth = buildShellCheckAuth(deps);

    let thrown: unknown;
    try {
      const auth = await checkAuth({ userId: 'u-1', shellId: 'shl-1' });
      if (auth.ok) await auth.resolveSandbox();
    } catch (error) {
      thrown = error;
    }

    assert({
      given: 'an ensureSessionSandbox that rejects after the slot was reserved',
      should: 'release the slot and propagate the original error (unchanged socket surface)',
      actual: { releases, thrown },
      expected: { releases: 1, thrown: boom },
    });
  });

  it('surfaces releaseSlot on the RESOLVED sandbox (the only path that reserves one)', async () => {
    let releases = 0;
    const { deps } = buildDeps({
      releaseSlot: () => {
        releases += 1;
      },
    });
    const checkAuth = buildShellCheckAuth(deps);

    const auth = await checkAuth({ userId: 'u-1', shellId: 'shl-1' });
    const sandbox = auth.ok ? await auth.resolveSandbox() : auth;
    if (sandbox.ok) sandbox.releaseSlot();

    assert({
      given: 'a successfully resolved sandbox whose caller releases the slot it reserved',
      should: 'expose releaseSlot on the sandbox result and release exactly the one slot taken',
      actual: { hasRelease: sandbox.ok ? typeof sandbox.releaseSlot : null, releases },
      expected: { hasRelease: 'function', releases: 1 },
    });
  });

  it('audits the resolved launch command (override preferred) against the resolved drive on success', async () => {
    const audits: Array<{ command: string; driveId: string | null }> = [];
    const { deps } = buildDeps({
      resolveShell: async () => ({
        ok: true,
        shell: { ...shellRow, command: 'claude --print' },
        cwd: '/home/user',
        spriteExecId: null,
      }),
      writeAudit: ({ command, driveId }) => {
        audits.push({ command, driveId });
      },
    });
    const checkAuth = buildShellCheckAuth(deps);

    const auth = await checkAuth({ userId: 'u-1', shellId: 'shl-1' });
    if (auth.ok) await auth.resolveSandbox();

    assert({
      given: 'a resolved shell with a command override',
      should: 'record the override in the audit line under the session drive',
      actual: audits,
      expected: [{ command: 'claude --print', driveId: 'drive-1' }],
    });
  });
});
