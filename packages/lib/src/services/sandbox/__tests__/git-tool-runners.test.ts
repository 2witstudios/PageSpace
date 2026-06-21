import { describe, it, expect, vi } from 'vitest';
import {
  runGitInSandbox,
  type GitSandboxRunDeps,
} from '../git-tool-runners';
import type { SandboxActorContext } from '../tool-runners';
import type { ExecutableSandbox, SandboxRunResult } from '../sandbox-client/types';

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
      preflight: async () => ({ allowed: true }),
      charge: async () => {},
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
      preflight: async () => ({ allowed: true }),
      charge: async () => {},
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

  it('always injects GH_CONFIG_DIR=/tmp/gh-config', async () => {
    const { deps, runCommandCalls } = makeDepsWithSpy();
    await runGitInSandbox({ cmd: 'gh', args: ['auth', 'status'], ctx: makeCtx(), deps });
    expect(runCommandCalls[0].env).toMatchObject({ GH_CONFIG_DIR: '/tmp/gh-config' });
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
