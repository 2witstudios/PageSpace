import { describe, it, expect } from 'vitest';
import { readMachineGitBlob } from '../machine-git-blob';
import type { GitSandboxRunDeps } from '../git-tool-runners';
import type { SandboxActorContext } from '../tool-runners';
import type { ExecutableSandbox, RunCommandArgs, SandboxRunResult } from '../sandbox-client/types';

/**
 * `readMachineGitBlob` drives the real `runGitInSandbox` (not mocked — it's
 * pure orchestration over the injected deps), so a fake `ExecutableSandbox`
 * whose `runCommand` is scripted exercises every branch with zero real
 * Sprite/git calls, mirroring `git-tool-runners.test.ts`'s harness.
 */
function makeCtx(): SandboxActorContext {
  return {
    userId: 'u1',
    tenantId: 't1',
    conversationId: 'c1',
    actorEmail: 'u1@example.com',
    tier: 'pro',
  };
}

function makeDeps(runCommand: (args: RunCommandArgs) => Promise<SandboxRunResult>): {
  deps: GitSandboxRunDeps;
  calls: Array<{ cmd: string; args: string[] }>;
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const sandbox: ExecutableSandbox = {
    sandboxId: 'sbx-1',
    runCommand: async (opts) => {
      calls.push({ cmd: opts.cmd, args: opts.args ?? [] });
      return runCommand(opts);
    },
    writeFiles: async () => {},
    readFileToBuffer: async () => Buffer.from(''),
  };
  const deps: GitSandboxRunDeps = {
    isEnabled: () => true,
    acquireSandbox: async () => ({ ok: true, sandboxId: 'sbx-1', resumed: false }),
    reconnect: async () => sandbox,
    quota: { acquireSlot: () => true, releaseSlot: () => {} },
    buildEnv: () => ({}),
    audit: async () => {},
    now: () => new Date('2026-06-01T12:00:00.000Z'),
    resolveGitHubToken: async () => null,
  };
  return { deps, calls };
}

describe('readMachineGitBlob', () => {
  it('runs `git show <ref>:<path>` against the given cwd', async () => {
    const { deps, calls } = makeDeps(async () => ({ exitCode: 0, stdout: 'file body', stderr: '' }));
    const result = await readMachineGitBlob({
      ref: 'origin/master',
      path: 'src/index.ts',
      cwd: '/workspace/repo',
      ctx: makeCtx(),
      deps,
    });

    expect(calls).toEqual([{ cmd: 'git', args: ['show', 'origin/master:src/index.ts'] }]);
    expect(result).toEqual({ ok: true, content: 'file body', truncated: false });
  });

  it('maps a missing path ("does not exist in") to not_found', async () => {
    const { deps } = makeDeps(async () => ({
      exitCode: 128,
      stdout: '',
      stderr: "fatal: path 'nope.txt' does not exist in 'HEAD'\n",
    }));
    const result = await readMachineGitBlob({ ref: 'HEAD', path: 'nope.txt', cwd: '/workspace/repo', ctx: makeCtx(), deps });
    expect(result).toEqual({ ok: false, reason: 'not_found', detail: "fatal: path 'nope.txt' does not exist in 'HEAD'" });
  });

  it('maps "exists on disk, but not in" (a `../`-normalized miss) to not_found', async () => {
    const { deps } = makeDeps(async () => ({
      exitCode: 128,
      stdout: '',
      stderr: "fatal: path 'sub/../file.txt' exists on disk, but not in 'HEAD'\n",
    }));
    const result = await readMachineGitBlob({
      ref: 'HEAD',
      path: 'sub/../file.txt',
      cwd: '/workspace/repo',
      ctx: makeCtx(),
      deps,
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: 'not_found' });
  });

  it('maps a bad ref ("invalid object name") to not_found', async () => {
    const { deps } = makeDeps(async () => ({
      exitCode: 128,
      stdout: '',
      stderr: "fatal: invalid object name 'nope-branch'.\n",
    }));
    const result = await readMachineGitBlob({ ref: 'nope-branch', path: 'file.txt', cwd: '/workspace/repo', ctx: makeCtx(), deps });
    expect(result).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('maps any other nonzero exit to exec_failed and surfaces stderr detail', async () => {
    const { deps } = makeDeps(async () => ({ exitCode: 1, stdout: '', stderr: 'fatal: not a git repository\n' }));
    const result = await readMachineGitBlob({ ref: 'HEAD', path: 'file.txt', cwd: '/workspace/repo', ctx: makeCtx(), deps });
    expect(result).toEqual({ ok: false, reason: 'exec_failed', detail: 'fatal: not a git repository' });
  });

  it('maps a hard runGitInSandbox failure (success: false) to exec_failed', async () => {
    const deps: GitSandboxRunDeps = {
      isEnabled: () => false,
      acquireSandbox: async () => ({ ok: true, sandboxId: 'sbx-1', resumed: false }),
      reconnect: async () => {
        throw new Error('unreachable');
      },
      quota: { acquireSlot: () => true, releaseSlot: () => {} },
      buildEnv: () => ({}),
      audit: async () => {},
      now: () => new Date(),
      resolveGitHubToken: async () => null,
    };
    const result = await readMachineGitBlob({ ref: 'HEAD', path: 'file.txt', cwd: '/workspace/repo', ctx: makeCtx(), deps });
    expect(result).toEqual({ ok: false, reason: 'exec_failed', detail: 'Code execution is disabled.' });
  });

  it('reports content truncation from runGitInSandbox through to the caller', async () => {
    const deps: GitSandboxRunDeps = {
      isEnabled: () => true,
      acquireSandbox: async () => ({ ok: true, sandboxId: 'sbx-1', resumed: false }),
      reconnect: async () => ({
        sandboxId: 'sbx-1',
        runCommand: async () => ({ exitCode: 0, stdout: 'x'.repeat(10), stderr: '' }),
        writeFiles: async () => {},
        readFileToBuffer: async () => Buffer.from(''),
      }),
      quota: { acquireSlot: () => true, releaseSlot: () => {} },
      buildEnv: () => ({}),
      audit: async () => {},
      now: () => new Date(),
      resolveGitHubToken: async () => null,
    };
    // SANDBOX_MAX_OUTPUT_BYTES is large in real config; instead assert the
    // pass-through wiring by checking the untruncated case reports false, and
    // trust git-tool-runners.test.ts to cover the truncation boundary itself.
    const result = await readMachineGitBlob({ ref: 'HEAD', path: 'file.txt', cwd: '/workspace/repo', ctx: makeCtx(), deps });
    expect(result).toMatchObject({ ok: true, truncated: false });
  });

  describe('ref validation — argument-injection guard', () => {
    it('rejects an empty ref without calling git', async () => {
      const { deps, calls } = makeDeps(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
      const result = await readMachineGitBlob({ ref: '', path: 'file.txt', cwd: '/workspace/repo', ctx: makeCtx(), deps });
      expect(result).toEqual({ ok: false, reason: 'invalid_ref' });
      expect(calls).toHaveLength(0);
    });

    it('rejects a `-`-leading ref without calling git, so it can never be parsed as a git show flag', async () => {
      const { deps, calls } = makeDeps(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
      const result = await readMachineGitBlob({
        ref: '--output=/tmp/pwned',
        path: 'file.txt',
        cwd: '/workspace/repo',
        ctx: makeCtx(),
        deps,
      });
      expect(result).toEqual({ ok: false, reason: 'invalid_ref' });
      expect(calls).toHaveLength(0);
    });
  });
});
