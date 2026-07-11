import { describe, it, expect, vi } from 'vitest';
import {
  runGitInSandbox,
  buildGitToolEnv,
  GH_CONFIG_DIR,
  type GitSandboxRunDeps,
} from '../git-tool-runners';
import type { SandboxActorContext } from '../tool-runners';
import type { ExecutableSandbox, SandboxRunResult } from '../sandbox-client/types';
import { SANDBOX_ROOT } from '../sandbox-paths';
import { assert } from './riteway';

const NOW = new Date('2026-06-01T12:00:00.000Z');

function makeCtx(over: Partial<SandboxActorContext> = {}): SandboxActorContext {
  return {
    userId: 'u1',
    tenantId: 't1',
    driveId: 'd1',
    conversationId: 'c1',
    actorEmail: 'u1@example.com',
    tier: 'pro',
    ...over,
  };
}

function makeSandbox(over: Partial<ExecutableSandbox> = {}): {
  sandbox: ExecutableSandbox;
  runCommandCalls: Array<Parameters<ExecutableSandbox['runCommand']>[0]>;
} {
  const runCommandCalls: Array<Parameters<ExecutableSandbox['runCommand']>[0]> = [];
  const sandbox: ExecutableSandbox = {
    sandboxId: 'sbx-1',
    runCommand: async (opts): Promise<SandboxRunResult> => {
      runCommandCalls.push(opts);
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    },
    writeFiles: async () => {},
    readFileToBuffer: async () => Buffer.from(''),
    ...over,
  };
  return { sandbox, runCommandCalls };
}

function makeDeps(over: Partial<GitSandboxRunDeps> = {}, token: string | null = 'ghp_test_token') {
  const slots = { acquired: 0, released: 0 };
  const { sandbox, runCommandCalls } = makeSandbox(over.reconnect ? undefined : undefined);
  const deps: GitSandboxRunDeps = {
    isEnabled: () => true,
    acquireSandbox: async () => ({ ok: true, sandboxId: 'sbx-1', resumed: false }),
    reconnect: async () => sandbox,
    quota: {
      acquireSlot: () => { slots.acquired += 1; return true; },
      releaseSlot: () => { slots.released += 1; },
    },
    buildEnv: () => ({ NODE_ENV: 'test' }),
    audit: async () => {},
    now: () => NOW,
    resolveGitHubToken: async () => token,
    ...over,
  };
  return { deps, slots, sandbox };
}

// Helper that captures runCommand calls by spying on the sandbox
function makeDepsWithSpy(token: string | null = 'ghp_test_token') {
  const runCommandCalls: Array<Parameters<ExecutableSandbox['runCommand']>[0]> = [];
  const sandbox: ExecutableSandbox = {
    sandboxId: 'sbx-1',
    runCommand: async (opts): Promise<SandboxRunResult> => {
      runCommandCalls.push(opts);
      return { exitCode: 0, stdout: 'hello', stderr: '' };
    },
    writeFiles: async () => {},
    readFileToBuffer: async () => Buffer.from(''),
  };
  const slots = { acquired: 0, released: 0 };
  const deps: GitSandboxRunDeps = {
    isEnabled: () => true,
    acquireSandbox: async () => ({ ok: true, sandboxId: 'sbx-1', resumed: false }),
    reconnect: async () => sandbox,
    quota: {
      acquireSlot: () => { slots.acquired += 1; return true; },
      releaseSlot: () => { slots.released += 1; },
    },
    buildEnv: () => ({ NODE_ENV: 'test' }),
    audit: async () => {},
    now: () => NOW,
    resolveGitHubToken: async () => token,
  };
  return { deps, slots, runCommandCalls };
}

describe('runGitInSandbox', () => {
  it('passes cmd and args directly to sandbox.runCommand — no sh -c wrapping', async () => {
    const { deps, runCommandCalls } = makeDepsWithSpy();
    await runGitInSandbox({ cmd: 'git', args: ['status'], ctx: makeCtx(), deps });
    expect(runCommandCalls).toHaveLength(1);
    expect(runCommandCalls[0].cmd).toBe('git');
    expect(runCommandCalls[0].args).toEqual(['status']);
  });

  it('given a ctx with an activeMachine set, should thread it onto the acquireSandbox request', async () => {
    const seen: unknown[] = [];
    const { deps } = makeDeps({
      acquireSandbox: async (input) => {
        seen.push(input);
        return { ok: true, sandboxId: 'sbx-1', resumed: false };
      },
    });
    await runGitInSandbox({
      cmd: 'git',
      args: ['status'],
      ctx: makeCtx({ activeMachine: { kind: 'existing', machineId: 't1' } }),
      deps,
    });
    expect(seen).toEqual([
      expect.objectContaining({ activeMachine: { kind: 'existing', machineId: 't1' } }),
    ]);
  });

  it('injects GH_TOKEN and GITHUB_TOKEN when resolver returns a token', async () => {
    const { deps, runCommandCalls } = makeDepsWithSpy('ghp_abc123');
    await runGitInSandbox({ cmd: 'gh', args: ['pr', 'list'], ctx: makeCtx(), deps });
    expect(runCommandCalls[0].env).toMatchObject({
      GH_TOKEN: 'ghp_abc123',
      GITHUB_TOKEN: 'ghp_abc123',
    });
  });

  it('configures a one-shot credential helper for git HTTPS authentication', async () => {
    const { deps, runCommandCalls } = makeDepsWithSpy('ghp_abc123');
    await runGitInSandbox({ cmd: 'git', args: ['fetch', 'origin'], ctx: makeCtx(), deps });
    const call = runCommandCalls[0];
    expect(call).toBeDefined();
    if (!call) throw new Error('expected runCommand call');
    const env = call.env;
    expect(env).toBeDefined();
    if (!env) throw new Error('expected runCommand env');
    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
    });
    const credentialHelper = env.GIT_CONFIG_VALUE_0;
    expect(credentialHelper).toBeDefined();
    if (!credentialHelper) throw new Error('expected credential helper');
    expect(credentialHelper).toContain('username=x-access-token');
    expect(credentialHelper).toContain('password=$GITHUB_TOKEN');
    expect(credentialHelper).not.toContain('ghp_abc123');
  });

  it('does not include GH_TOKEN or GITHUB_TOKEN when resolver returns null', async () => {
    const { deps, runCommandCalls } = makeDepsWithSpy(null);
    await runGitInSandbox({ cmd: 'git', args: ['status'], ctx: makeCtx(), deps });
    expect(runCommandCalls[0].env).not.toHaveProperty('GH_TOKEN');
    expect(runCommandCalls[0].env).not.toHaveProperty('GITHUB_TOKEN');
    expect(runCommandCalls[0].env).not.toHaveProperty('GIT_CONFIG_VALUE_0');
  });

  it('always injects GIT_TERMINAL_PROMPT=0', async () => {
    const { deps, runCommandCalls } = makeDepsWithSpy();
    await runGitInSandbox({ cmd: 'git', args: ['fetch'], ctx: makeCtx(), deps });
    expect(runCommandCalls[0].env).toMatchObject({ GIT_TERMINAL_PROMPT: '0' });
  });

  it('always injects GIT_CONFIG_NOSYSTEM=1', async () => {
    const { deps, runCommandCalls } = makeDepsWithSpy();
    await runGitInSandbox({ cmd: 'git', args: ['clone', 'https://github.com/a/b'], ctx: makeCtx(), deps });
    expect(runCommandCalls[0].env).toMatchObject({ GIT_CONFIG_NOSYSTEM: '1' });
  });

  it('always injects GH_CONFIG_DIR pointed at the persistent disk, not /tmp', async () => {
    const { deps, runCommandCalls } = makeDepsWithSpy();
    await runGitInSandbox({ cmd: 'gh', args: ['auth', 'status'], ctx: makeCtx(), deps });
    expect(runCommandCalls[0].env).toMatchObject({ GH_CONFIG_DIR });
    expect(runCommandCalls[0].env?.GH_CONFIG_DIR).not.toContain('/tmp');
    // Must NOT live under the workspace root — git_clone/git_init default their
    // destination there, and a non-empty /workspace breaks a no-path clone.
    expect(runCommandCalls[0].env?.GH_CONFIG_DIR?.startsWith(`${SANDBOX_ROOT}/`)).toBe(false);
  });

  it('returns success result with stdout, stderr, exitCode, truncated', async () => {
    const { deps } = makeDepsWithSpy();
    const result = await runGitInSandbox({ cmd: 'git', args: ['status'], ctx: makeCtx(), deps });
    expect(result).toMatchObject({ success: true, stdout: 'hello', stderr: '', exitCode: 0, truncated: false });
  });

  it('uses the dev profile (persistent, egress-enabled) not the default profile', async () => {
    // The dev profile has timeoutMs=120_000 — verify it's passed to runCommand
    const { deps, runCommandCalls } = makeDepsWithSpy();
    await runGitInSandbox({ cmd: 'git', args: ['status'], ctx: makeCtx(), deps });
    expect(runCommandCalls[0].timeoutMs).toBe(120_000);
  });

  it('given no cwd, should default the working directory to the sandbox root', async () => {
    const { deps, runCommandCalls } = makeDepsWithSpy();
    await runGitInSandbox({ cmd: 'git', args: ['status'], ctx: makeCtx(), deps });
    expect(runCommandCalls[0].cwd).toBe(SANDBOX_ROOT);
  });

  it('given a valid relative cwd, should forward the resolved absolute path to runCommand', async () => {
    const { deps, runCommandCalls } = makeDepsWithSpy();
    await runGitInSandbox({ cmd: 'git', args: ['status'], cwd: 'myrepo', ctx: makeCtx(), deps });
    expect(runCommandCalls[0].cwd).toBe(`${SANDBOX_ROOT}/myrepo`);
  });

  it('given a cwd that escapes the sandbox root, should deny path_escape before acquiring a slot', async () => {
    const { deps, slots, runCommandCalls } = makeDepsWithSpy();
    const result = await runGitInSandbox({
      cmd: 'git',
      args: ['status'],
      cwd: '../../etc',
      ctx: makeCtx(),
      deps,
    });
    expect(result).toMatchObject({ success: false, reason: 'path_escape' });
    expect(slots.acquired).toBe(0);
    expect(runCommandCalls).toHaveLength(0);
  });

  it('releases the concurrency slot in finally even when sandbox.runCommand throws', async () => {
    const { deps, slots } = makeDepsWithSpy();
    deps.reconnect = async () => ({
      sandboxId: 'sbx-1',
      runCommand: async () => { throw new Error('run failed'); },
      writeFiles: async () => {},
      readFileToBuffer: async () => null,
    });
    const result = await runGitInSandbox({ cmd: 'git', args: ['status'], ctx: makeCtx(), deps });
    expect(result).toMatchObject({ success: false });
    expect(slots.released).toBe(slots.acquired);
  });
});

describe('runGitInSandbox — injection seam (screenOutput, fail-open)', () => {
  it('screens git stdout AND stderr through deps.screenOutput before returning to the model', async () => {
    const { sandbox } = makeSandbox({
      runCommand: async () => ({ exitCode: 0, stdout: 'log out', stderr: 'log err' }),
    });
    const { deps } = makeDeps({
      reconnect: async () => sandbox,
      screenOutput: async (t) => `[SCREENED]${t}`,
    });
    const result = await runGitInSandbox({ cmd: 'git', args: ['log'], ctx: makeCtx(), deps });
    expect(result).toMatchObject({ success: true });
    if (result.success) {
      expect(result.stdout).toBe('[SCREENED]log out');
      expect(result.stderr).toBe('[SCREENED]log err');
    }
  });

  it('given NO screenOutput hook, git output passes through unchanged (seam disabled)', async () => {
    const { sandbox } = makeSandbox({
      runCommand: async () => ({ exitCode: 0, stdout: 'plain', stderr: '' }),
    });
    const { deps } = makeDeps({ reconnect: async () => sandbox });
    const result = await runGitInSandbox({ cmd: 'git', args: ['log'], ctx: makeCtx(), deps });
    if (result.success) expect(result.stdout).toBe('plain');
  });
});

describe('buildGitToolEnv (pure)', () => {
  const base = { NODE_ENV: 'test' };

  it('given the tool env, should root GH_CONFIG_DIR at an absolute persistent path (not /tmp)', () => {
    const env = buildGitToolEnv({ baseEnv: base, token: 'ghp_x' });
    assert({
      given: 'a git/gh tool env',
      should: 'root GH_CONFIG_DIR at an absolute, non-ephemeral disk path',
      actual: env.GH_CONFIG_DIR.startsWith('/') && !env.GH_CONFIG_DIR.includes('/tmp'),
      expected: true,
    });
  });

  it('given any token state, should never reference /tmp in any env value', () => {
    const withToken = buildGitToolEnv({ baseEnv: base, token: 'ghp_x' });
    const withoutToken = buildGitToolEnv({ baseEnv: base, token: null });
    const referencesTmp = (env: Record<string, string>) =>
      Object.values(env).some((v) => v.includes('/tmp'));
    assert({
      given: 'the tool env with and without a token',
      should: 'contain no /tmp path in any value',
      actual: referencesTmp(withToken) || referencesTmp(withoutToken),
      expected: false,
    });
  });

  it('given the GH_CONFIG_DIR path, should sit entirely outside the workspace root', () => {
    // git_clone / git_init default their destination to SANDBOX_ROOT itself, so
    // ANY path under /workspace (not just /workspace/repo) would collide: a
    // non-empty /workspace breaks a no-path clone. The config dir must be fully
    // outside the workspace root. (Widen to string — the literal constants are
    // provably disjoint, which would otherwise trip TS's unintentional-compare
    // check.)
    const dir: string = GH_CONFIG_DIR;
    const root: string = SANDBOX_ROOT;
    assert({
      given: 'the persistent gh config dir',
      should: 'be neither the workspace root nor nested under it',
      actual: dir === root || dir.startsWith(`${root}/`),
      expected: false,
    });
  });

  it('given a token, should inject GH_TOKEN, GITHUB_TOKEN and the credential helper', () => {
    const env = buildGitToolEnv({ baseEnv: base, token: 'ghp_abc' });
    assert({
      given: 'a resolved GitHub token',
      should: 'expose both token env vars plus the one-shot credential-helper config',
      actual: {
        GH_TOKEN: env.GH_TOKEN,
        GITHUB_TOKEN: env.GITHUB_TOKEN,
        GIT_CONFIG_COUNT: env.GIT_CONFIG_COUNT,
        GIT_CONFIG_KEY_0: env.GIT_CONFIG_KEY_0,
        hasHelper: typeof env.GIT_CONFIG_VALUE_0 === 'string',
      },
      expected: {
        GH_TOKEN: 'ghp_abc',
        GITHUB_TOKEN: 'ghp_abc',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.helper',
        hasHelper: true,
      },
    });
  });

  it('given no token, should omit token env vars but keep the pause-proof config dir', () => {
    const env = buildGitToolEnv({ baseEnv: base, token: null });
    assert({
      given: 'a null token',
      should: 'omit token vars yet still root GH_CONFIG_DIR on the persistent disk',
      actual: {
        hasGhToken: 'GH_TOKEN' in env,
        hasGithubToken: 'GITHUB_TOKEN' in env,
        hasHelper: 'GIT_CONFIG_VALUE_0' in env,
        ghConfigDir: env.GH_CONFIG_DIR,
      },
      expected: {
        hasGhToken: false,
        hasGithubToken: false,
        hasHelper: false,
        ghConfigDir: GH_CONFIG_DIR,
      },
    });
  });

  it('given a base env, should preserve base vars and the always-on git safety flags', () => {
    const env = buildGitToolEnv({ baseEnv: base, token: null });
    assert({
      given: 'a base sandbox env',
      should: 'carry base vars through alongside the git safety flags',
      actual: {
        NODE_ENV: env.NODE_ENV,
        GIT_TERMINAL_PROMPT: env.GIT_TERMINAL_PROMPT,
        GIT_CONFIG_NOSYSTEM: env.GIT_CONFIG_NOSYSTEM,
      },
      expected: { NODE_ENV: 'test', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
    });
  });
});
