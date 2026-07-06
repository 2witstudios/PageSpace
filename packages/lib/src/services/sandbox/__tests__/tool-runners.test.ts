import { describe, it, expect, vi } from 'vitest';
import {
  runBashInSandbox,
  writeSandboxFile,
  readSandboxFile,
  editSandboxFile,
  MAX_WRITE_BYTES,
  type SandboxActorContext,
  type SandboxRunDeps,
} from '../tool-runners';
import type { ExecutableSandbox, SandboxRunResult } from '../sandbox-client/types';
import type { CodeExecutionAuditInput } from '../audit';
import { SANDBOX_ROOT } from '../sandbox-paths';

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

function makeSandbox(over: Partial<ExecutableSandbox> = {}): ExecutableSandbox {
  return {
    sandboxId: 'sbx-1',
    runCommand: async (): Promise<SandboxRunResult> => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
    writeFiles: async () => {},
    readFileToBuffer: async () => Buffer.from('file-contents'),
    ...over,
  };
}

function makeDeps(over: Partial<SandboxRunDeps> = {}) {
  const audits: CodeExecutionAuditInput[] = [];
  const slots = { acquired: 0, released: 0 };
  const sandbox = over.reconnect ? undefined : makeSandbox();
  const deps: SandboxRunDeps = {
    isEnabled: () => true,
    acquireSandbox: async () => ({ ok: true, sandboxId: 'sbx-1', resumed: false }),
    reconnect: async () => sandbox ?? null,
    quota: {
      acquireSlot: () => {
        slots.acquired += 1;
        return true;
      },
      releaseSlot: () => {
        slots.released += 1;
      },
    },
    buildEnv: () => ({ NODE_ENV: 'test' }),
    audit: async (input) => {
      audits.push(input);
    },
    now: () => NOW,
    ...over,
  };
  return { deps, audits, slots };
}

describe('runBashInSandbox', () => {
  it('given the kill-switch off, should deny without acquiring a slot or auditing', async () => {
    const { deps, slots, audits } = makeDeps({ isEnabled: () => false });
    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx(), deps });
    expect(result).toMatchObject({ success: false, reason: 'kill_switch_off' });
    expect(slots.acquired).toBe(0);
    expect(audits).toHaveLength(0);
  });

  it('given a blocked command, should deny, audit a blocked_command anomaly, and never provision', async () => {
    let acquireCalls = 0;
    const { deps, audits } = makeDeps({
      acquireSandbox: async () => {
        acquireCalls += 1;
        return { ok: true, sandboxId: 'sbx-1', resumed: false };
      },
    });
    const result = await runBashInSandbox({
      command: 'curl http://169.254.169.254/',
      ctx: makeCtx(),
      deps,
    });
    expect(result).toMatchObject({ success: false, reason: 'blocked_metadata_access' });
    expect(acquireCalls).toBe(0);
    expect(audits[0]?.anomaly).toBe('blocked_command');
    expect(audits[0]?.exitCode).toBeNull();
  });

  it('given a GitHub op over bash (no creds there), should deny github_over_bash, audit blocked_command, and never provision', async () => {
    let acquireCalls = 0;
    const { deps, audits } = makeDeps({
      acquireSandbox: async () => {
        acquireCalls += 1;
        return { ok: true, sandboxId: 'sbx-1', resumed: false };
      },
    });
    const result = await runBashInSandbox({ command: 'gh pr list', ctx: makeCtx(), deps });
    expect(result).toMatchObject({ success: false, reason: 'github_over_bash' });
    expect(acquireCalls).toBe(0);
    expect(audits[0]?.anomaly).toBe('blocked_command');
  });

  it('given a saturated concurrency limit, should deny with concurrency_limit', async () => {
    const { deps } = makeDeps({
      quota: {
        acquireSlot: () => false,
        releaseSlot: () => {},
      },
    });
    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx(), deps });
    expect(result).toMatchObject({ success: false, reason: 'concurrency_limit' });
  });

  it('given an authz denial from acquire, should map the reason and release the slot', async () => {
    const { deps, slots } = makeDeps({
      acquireSandbox: async () => ({ ok: false, reason: 'insufficient_role' }),
    });
    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx(), deps });
    expect(result).toMatchObject({ success: false, reason: 'insufficient_role' });
    expect(slots.released).toBe(1);
  });

  it('given a ctx with an activeMachine set, should thread it onto the acquireSandbox request', async () => {
    const seen: unknown[] = [];
    const { deps } = makeDeps({
      acquireSandbox: async (input) => {
        seen.push(input);
        return { ok: true, sandboxId: 'sbx-1', resumed: false };
      },
    });
    await runBashInSandbox({
      command: 'echo hi',
      ctx: makeCtx({ activeMachine: { kind: 'existing', terminalId: 't1' } }),
      deps,
    });
    expect(seen).toEqual([
      expect.objectContaining({ activeMachine: { kind: 'existing', terminalId: 't1' } }),
    ]);
  });

  it('given no_machine from acquire (e.g. an "own" machine with no backing page), should deny no_machine and release the slot', async () => {
    const { deps, slots } = makeDeps({
      acquireSandbox: async () => ({ ok: false, reason: 'no_machine' }),
    });
    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx(), deps });
    expect(result).toMatchObject({ success: false, reason: 'no_machine' });
    expect(slots.released).toBe(1);
  });

  it('given an authz denial from acquire and a throwing logger, should still release the slot and map the reason', async () => {
    const { deps, slots } = makeDeps({
      acquireSandbox: async () => ({ ok: false, reason: 'insufficient_role' }),
      logger: {
        error: () => {
          throw new Error('logger failed');
        },
      },
    });

    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx(), deps });

    expect(result).toMatchObject({ success: false, reason: 'insufficient_role' });
    expect(slots.released).toBe(1);
  });

  it('given a vanished sandbox on reconnect, should deny provision_failed and release the slot', async () => {
    const { deps, slots } = makeDeps({ reconnect: async () => null });
    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx(), deps });
    expect(result).toMatchObject({ success: false, reason: 'provision_failed' });
    expect(slots.released).toBe(1);
  });

  it('given a vanished sandbox on reconnect and a throwing logger, should still deny provision_failed and release the slot', async () => {
    const { deps, slots } = makeDeps({
      reconnect: async () => null,
      logger: {
        error: () => {
          throw new Error('logger failed');
        },
      },
    });

    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx(), deps });

    expect(result).toMatchObject({ success: false, reason: 'provision_failed' });
    expect(slots.released).toBe(1);
  });

  it('given a successful run, should return output, audit the run, and release the slot', async () => {
    const { deps, audits, slots } = makeDeps();
    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx(), deps });
    expect(result).toEqual({ success: true, stdout: 'ok', stderr: '', exitCode: 0, truncated: false });
    expect(audits[0]).toMatchObject({ exitCode: 0, code: 'echo hi', anomaly: undefined });
    expect(slots.released).toBe(1);
  });

  it('given a successful run and a resolved machine pageId, should notify the terminal activity feed', async () => {
    const notified: unknown[] = [];
    const { deps } = makeDeps({
      acquireSandbox: async () => ({ ok: true, sandboxId: 'sbx-1', resumed: false, pageId: 'terminal-page-1' }),
      notifyTerminalActivity: async (input) => {
        notified.push(input);
      },
    });
    const result = await runBashInSandbox({
      command: 'echo hi',
      ctx: makeCtx({ actorDisplayName: 'Agent Bob' }),
      deps,
    });
    expect(result).toMatchObject({ success: true });
    expect(notified).toEqual([
      {
        pageId: 'terminal-page-1',
        driveId: 'd1',
        tenantId: 't1',
        command: 'echo hi',
        output: 'ok',
        exitCode: 0,
        agentLabel: 'Agent Bob',
      },
    ]);
  });

  it('given no resolved machine pageId, should never call the terminal activity feed', async () => {
    const notified: unknown[] = [];
    const { deps } = makeDeps({
      acquireSandbox: async () => ({ ok: true, sandboxId: 'sbx-1', resumed: false }),
      notifyTerminalActivity: async (input) => {
        notified.push(input);
      },
    });
    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx(), deps });
    expect(result).toMatchObject({ success: true });
    expect(notified).toEqual([]);
  });

  it('given a throwing terminal activity feed, should still return the successful result', async () => {
    const { deps } = makeDeps({
      acquireSandbox: async () => ({ ok: true, sandboxId: 'sbx-1', resumed: false, pageId: 'terminal-page-1' }),
      notifyTerminalActivity: async () => {
        throw new Error('feed down');
      },
    });
    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx(), deps });
    expect(result).toEqual({ success: true, stdout: 'ok', stderr: '', exitCode: 0, truncated: false });
  });

  it('given a slow-to-resolve terminal activity feed, should NOT block the tool result on it (fire-and-forget)', async () => {
    let releaseFeed: (() => void) | undefined;
    const feedGate = new Promise<void>((resolve) => {
      releaseFeed = resolve;
    });
    const { deps } = makeDeps({
      acquireSandbox: async () => ({ ok: true, sandboxId: 'sbx-1', resumed: false, pageId: 'terminal-page-1' }),
      notifyTerminalActivity: async () => {
        await feedGate; // Never resolves during this test unless we release it.
      },
    });

    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx(), deps });

    expect(result).toMatchObject({ success: true });
    releaseFeed?.(); // Avoid leaving a dangling unresolved promise after the test.
  });

  it('given both stdout and stderr, should combine them for the terminal activity feed instead of dropping stderr', async () => {
    const notified: Array<{ output: string }> = [];
    const { deps } = makeDeps({
      acquireSandbox: async () => ({ ok: true, sandboxId: 'sbx-1', resumed: false, pageId: 'terminal-page-1' }),
      reconnect: async () =>
        makeSandbox({ runCommand: async () => ({ exitCode: 0, stdout: 'out-line', stderr: 'err-line' }) }),
      notifyTerminalActivity: async (input) => {
        notified.push(input);
      },
    });
    await runBashInSandbox({ command: 'echo hi', ctx: makeCtx(), deps });
    expect(notified[0]?.output).toBe('out-line\nerr-line');
  });

  it('given no actorDisplayName, should fall back to a generic label instead of the actor\'s raw email (PII)', async () => {
    const notified: Array<{ agentLabel: string }> = [];
    const { deps } = makeDeps({
      acquireSandbox: async () => ({ ok: true, sandboxId: 'sbx-1', resumed: false, pageId: 'terminal-page-1' }),
      notifyTerminalActivity: async (input) => {
        notified.push(input);
      },
    });
    await runBashInSandbox({
      command: 'echo hi',
      ctx: makeCtx({ actorEmail: 'someone@example.com', actorDisplayName: undefined }),
      deps,
    });
    expect(notified[0]?.agentLabel).toBe('AI agent');
    expect(notified[0]?.agentLabel).not.toContain('@');
  });

  it('given output over the cap, should truncate and flag it', async () => {
    const big = 'x'.repeat(300 * 1024);
    const { deps } = makeDeps({
      reconnect: async () =>
        makeSandbox({ runCommand: async () => ({ exitCode: 0, stdout: big, stderr: '' }) }),
    });
    const result = await runBashInSandbox({ command: 'cat big', ctx: makeCtx(), deps });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(256 * 1024);
  });

  it('given a SIGKILL exit (137), should audit a timeout anomaly', async () => {
    const { deps, audits } = makeDeps({
      reconnect: async () =>
        makeSandbox({ runCommand: async () => ({ exitCode: 137, stdout: '', stderr: '' }) }),
    });
    const result = await runBashInSandbox({ command: 'sleep 999', ctx: makeCtx(), deps });
    expect(result).toMatchObject({ success: true, exitCode: 137 });
    expect(audits[0]?.anomaly).toBe('timeout');
  });

  it('given a non-zero exit, should audit a nonzero_exit anomaly', async () => {
    const { deps, audits } = makeDeps({
      reconnect: async () =>
        makeSandbox({ runCommand: async () => ({ exitCode: 1, stdout: '', stderr: 'boom' }) }),
    });
    await runBashInSandbox({ command: 'false', ctx: makeCtx(), deps });
    expect(audits[0]?.anomaly).toBe('nonzero_exit');
  });

  it('given runCommand throwing, should deny execution_failed, audit timeout, and release the slot', async () => {
    const { deps, audits, slots } = makeDeps({
      reconnect: async () =>
        makeSandbox({
          runCommand: async () => {
            throw new Error('killed');
          },
        }),
    });
    const result = await runBashInSandbox({ command: 'sleep 999', ctx: makeCtx(), deps });
    expect(result).toMatchObject({ success: false, reason: 'execution_failed' });
    expect(audits[0]?.anomaly).toBe('timeout');
    expect(slots.released).toBe(1);
  });

  it('given runCommand and logging both throw, should deny execution_failed, audit timeout, and release the slot', async () => {
    const { deps, audits, slots } = makeDeps({
      reconnect: async () =>
        makeSandbox({
          runCommand: async () => {
            throw new Error('killed');
          },
        }),
      logger: {
        error: () => {
          throw new Error('logger failed');
        },
      },
    });

    const result = await runBashInSandbox({ command: 'sleep 999', ctx: makeCtx(), deps });

    expect(result).toMatchObject({ success: false, reason: 'execution_failed' });
    expect(audits[0]?.anomaly).toBe('timeout');
    expect(slots.released).toBe(1);
  });

  it('given sandbox open throws and logging also throws, should release the slot and return error', async () => {
    const { deps, slots } = makeDeps({
      acquireSandbox: async () => {
        throw new Error('open failed');
      },
      logger: {
        error: () => {
          throw new Error('logger failed');
        },
      },
    });

    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx(), deps });

    expect(result).toMatchObject({ success: false, reason: 'error' });
    expect(slots.released).toBe(1);
  });

  it('given a cwd that escapes the sandbox root, should deny path_escape, audit it, and never provision', async () => {
    let acquired = false;
    const { deps, audits } = makeDeps({
      acquireSandbox: async () => {
        acquired = true;
        return { ok: true, sandboxId: 'sbx-1', resumed: false };
      },
    });
    const result = await runBashInSandbox({ command: 'ls', cwd: '../../etc', ctx: makeCtx(), deps });
    expect(result).toMatchObject({ success: false, reason: 'path_escape' });
    expect(acquired).toBe(false);
    // The attempted cwd escape on the bash path must be audited, like writeFile/
    // readFile path escapes — not silently dropped.
    expect(audits[0]?.anomaly).toBe('blocked_command');
  });

  it('given a sh -c invocation, should pass the command as a structured arg array (no host shell string)', async () => {
    let seen: { cmd: string; args?: string[] } | null = null;
    const { deps } = makeDeps({
      reconnect: async () =>
        makeSandbox({
          runCommand: async (a) => {
            seen = { cmd: a.cmd, args: a.args };
            return { exitCode: 0, stdout: '', stderr: '' };
          },
        }),
    });
    await runBashInSandbox({ command: 'echo $(whoami)', ctx: makeCtx(), deps });
    expect(seen).toEqual({ cmd: 'sh', args: ['-c', 'echo $(whoami)'] });
  });

  it('should forward the flat timeout and output-byte cap to the driver', async () => {
    let seen: { timeoutMs?: number; maxBytes?: number } | null = null;
    const { deps } = makeDeps({
      reconnect: async () =>
        makeSandbox({
          runCommand: async (a) => {
            seen = { timeoutMs: a.timeoutMs, maxBytes: a.maxBytes };
            return { exitCode: 0, stdout: '', stderr: '' };
          },
        }),
    });
    await runBashInSandbox({ command: 'echo hi', ctx: makeCtx(), deps });
    expect(seen).toEqual({ timeoutMs: 120_000, maxBytes: 256 * 1024 });
  });

  it('given an explicit timeoutMs, should forward it to the driver instead of the default', async () => {
    let seenTimeout: number | undefined;
    const { deps } = makeDeps({
      reconnect: async () =>
        makeSandbox({
          runCommand: async (a) => {
            seenTimeout = a.timeoutMs;
            return { exitCode: 0, stdout: '', stderr: '' };
          },
        }),
    });
    await runBashInSandbox({ command: 'bun install', timeoutMs: 180_000, ctx: makeCtx(), deps });
    expect(seenTimeout).toBe(180_000);
  });

  it('given a timeoutMs above the max, should clamp it down instead of passing it through raw', async () => {
    let seenTimeout: number | undefined;
    const { deps } = makeDeps({
      reconnect: async () =>
        makeSandbox({
          runCommand: async (a) => {
            seenTimeout = a.timeoutMs;
            return { exitCode: 0, stdout: '', stderr: '' };
          },
        }),
    });
    await runBashInSandbox({ command: 'bun install', timeoutMs: 10_000_000, ctx: makeCtx(), deps });
    expect(seenTimeout).toBe(200_000);
  });

  it('given no timeoutMs, should default to SANDBOX_TIMEOUT_MS unchanged', async () => {
    let seenTimeout: number | undefined;
    const { deps } = makeDeps({
      reconnect: async () =>
        makeSandbox({
          runCommand: async (a) => {
            seenTimeout = a.timeoutMs;
            return { exitCode: 0, stdout: '', stderr: '' };
          },
        }),
    });
    await runBashInSandbox({ command: 'echo hi', ctx: makeCtx(), deps });
    expect(seenTimeout).toBe(120_000);
  });

  it('given a non-positive timeoutMs (bypassing the zod schema at this exported layer), should clamp to a floor of 1 instead of passing it through raw', async () => {
    let seenTimeout: number | undefined;
    const { deps } = makeDeps({
      reconnect: async () =>
        makeSandbox({
          runCommand: async (a) => {
            seenTimeout = a.timeoutMs;
            return { exitCode: 0, stdout: '', stderr: '' };
          },
        }),
    });
    await runBashInSandbox({ command: 'echo hi', timeoutMs: 0, ctx: makeCtx(), deps });
    expect(seenTimeout).toBe(1);
  });
});

describe('writeSandboxFile', () => {
  it('given a traversal path, should deny path_escape and audit a blocked_command', async () => {
    const { deps, audits } = makeDeps();
    const result = await writeSandboxFile({
      path: '../../etc/passwd',
      content: 'x',
      ctx: makeCtx(),
      deps,
    });
    expect(result).toMatchObject({ success: false, reason: 'path_escape' });
    expect(audits[0]?.anomaly).toBe('blocked_command');
  });

  it('given oversized content, should deny content_too_large', async () => {
    const { deps } = makeDeps();
    const content = 'a'.repeat(MAX_WRITE_BYTES + 1);
    const result = await writeSandboxFile({ path: 'big.txt', content, ctx: makeCtx(), deps });
    expect(result).toMatchObject({ success: false, reason: 'content_too_large' });
  });

  it('given a valid write, should resolve under the sandbox root and report bytes', async () => {
    const writtenPaths: string[] = [];
    const { deps, slots } = makeDeps({
      reconnect: async () =>
        makeSandbox({
          writeFiles: async (files) => {
            writtenPaths.push(...files.map((f) => f.path));
          },
        }),
    });
    const result = await writeSandboxFile({ path: 'a/b.txt', content: 'hi', ctx: makeCtx(), deps });
    expect(result).toEqual({ success: true, path: 'a/b.txt', bytesWritten: 2 });
    expect(writtenPaths[0]).toBe(`${SANDBOX_ROOT}/a/b.txt`);
    expect(slots.released).toBe(1);
  });
});

describe('editSandboxFile', () => {
  function makeEditDeps(fileContents: string | null) {
    const written: Array<{ path: string; content: string | Uint8Array }> = [];
    const { deps, slots, audits } = makeDeps({
      reconnect: async () =>
        makeSandbox({
          readFileToBuffer: async () => (fileContents === null ? null : Buffer.from(fileContents)),
          writeFiles: async (files) => {
            written.push(...files);
          },
        }),
    });
    return { deps, slots, audits, written };
  }

  it('given a unique oldString, should write the edited content and report one replacement', async () => {
    const { deps, written, slots } = makeEditDeps('hello world');
    const result = await editSandboxFile({
      path: 'a.txt',
      oldString: 'world',
      newString: 'there',
      ctx: makeCtx(),
      deps,
    });
    expect(result).toMatchObject({ success: true, path: 'a.txt', replacements: 1 });
    expect(written[0]).toEqual({ path: `${SANDBOX_ROOT}/a.txt`, content: 'hello there' });
    expect(slots.released).toBe(1);
  });

  it('given replaceAll, should replace every occurrence', async () => {
    const { deps, written } = makeEditDeps('x x x');
    const result = await editSandboxFile({
      path: 'a.txt',
      oldString: 'x',
      newString: 'Y',
      replaceAll: true,
      ctx: makeCtx(),
      deps,
    });
    expect(result).toMatchObject({ success: true, replacements: 3 });
    expect(written[0].content).toBe('Y Y Y');
  });

  it('given a traversal path, should deny path_escape before provisioning and audit a blocked_command', async () => {
    let acquired = false;
    const { deps, audits } = makeDeps({
      acquireSandbox: async () => {
        acquired = true;
        return { ok: true, sandboxId: 'sbx-1', resumed: false };
      },
    });
    const result = await editSandboxFile({
      path: '../../etc/passwd',
      oldString: 'a',
      newString: 'b',
      ctx: makeCtx(),
      deps,
    });
    expect(result).toMatchObject({ success: false, reason: 'path_escape' });
    expect(acquired).toBe(false);
    expect(audits[0]?.anomaly).toBe('blocked_command');
  });

  it('given a missing file, should deny not_found', async () => {
    const { deps } = makeEditDeps(null);
    const result = await editSandboxFile({
      path: 'nope.txt',
      oldString: 'a',
      newString: 'b',
      ctx: makeCtx(),
      deps,
    });
    expect(result).toMatchObject({ success: false, reason: 'not_found' });
  });

  it('given an oldString that does not occur, should deny edit_no_match', async () => {
    const { deps } = makeEditDeps('hello');
    const result = await editSandboxFile({
      path: 'a.txt',
      oldString: 'zzz',
      newString: 'b',
      ctx: makeCtx(),
      deps,
    });
    expect(result).toMatchObject({ success: false, reason: 'edit_no_match' });
  });

  it('given a non-unique oldString without replaceAll, should deny edit_not_unique', async () => {
    const { deps } = makeEditDeps('x x');
    const result = await editSandboxFile({
      path: 'a.txt',
      oldString: 'x',
      newString: 'Y',
      ctx: makeCtx(),
      deps,
    });
    expect(result).toMatchObject({ success: false, reason: 'edit_not_unique' });
  });

  it('given an edit that grows the file past the write cap, should deny content_too_large', async () => {
    const { deps } = makeEditDeps('SEED');
    const huge = 'a'.repeat(MAX_WRITE_BYTES + 10);
    const result = await editSandboxFile({
      path: 'a.txt',
      oldString: 'SEED',
      newString: huge,
      ctx: makeCtx(),
      deps,
    });
    expect(result).toMatchObject({ success: false, reason: 'content_too_large' });
  });
});

describe('readSandboxFile', () => {
  it('given a missing file, should deny not_found and audit a nonzero exit', async () => {
    const { deps, audits } = makeDeps({
      reconnect: async () => makeSandbox({ readFileToBuffer: async () => null }),
    });
    const result = await readSandboxFile({ path: 'nope.txt', ctx: makeCtx(), deps });
    expect(result).toMatchObject({ success: false, reason: 'not_found' });
    expect(audits[0]?.anomaly).toBe('nonzero_exit');
  });

  it('given a present file, should return its contents and audit success', async () => {
    const { deps, audits, slots } = makeDeps();
    const result = await readSandboxFile({ path: 'a.txt', ctx: makeCtx(), deps });
    expect(result).toMatchObject({ success: true, path: 'a.txt', content: 'file-contents', truncated: false });
    expect(audits[0]?.exitCode).toBe(0);
    expect(slots.released).toBe(1);
  });

  it('given a file larger than the cap, should truncate', async () => {
    const big = Buffer.from('y'.repeat(300 * 1024));
    const { deps } = makeDeps({
      reconnect: async () => makeSandbox({ readFileToBuffer: async () => big }),
    });
    const result = await readSandboxFile({ path: 'big.txt', ctx: makeCtx(), deps });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.truncated).toBe(true);
  });

  it('given a traversal path, should deny path_escape before provisioning', async () => {
    let acquired = false;
    const { deps } = makeDeps({
      acquireSandbox: async () => {
        acquired = true;
        return { ok: true, sandboxId: 'sbx-1', resumed: false };
      },
    });
    const result = await readSandboxFile({ path: '/etc/passwd', ctx: makeCtx(), deps });
    expect(result).toMatchObject({ success: false, reason: 'path_escape' });
    expect(acquired).toBe(false);
  });
});

describe('injection seam wiring (screenOutput, fail-open)', () => {
  it('given a screenOutput hook, bash stdout is screened before it returns to the model', async () => {
    const { deps } = makeDeps({ screenOutput: async (t) => `[SCREENED]${t}` });
    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx(), deps });
    expect(result).toMatchObject({ success: true });
    if (result.success) expect(result.stdout).toBe('[SCREENED]ok');
  });

  it('given NO screenOutput hook, bash stdout passes through unchanged (seam disabled)', async () => {
    const { deps } = makeDeps();
    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx(), deps });
    if (result.success) expect(result.stdout).toBe('ok');
  });

  it('given a screenOutput hook, bash STDERR is also screened (injected instructions can be on stderr)', async () => {
    const sandbox = makeSandbox({
      runCommand: async () => ({ exitCode: 0, stdout: 'out', stderr: 'err' }),
    });
    const { deps } = makeDeps({
      reconnect: async () => sandbox,
      screenOutput: async (t) => `[SCREENED]${t}`,
    });
    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx(), deps });
    expect(result).toMatchObject({ success: true });
    if (result.success) {
      expect(result.stdout).toBe('[SCREENED]out');
      expect(result.stderr).toBe('[SCREENED]err');
    }
  });

  it('given a screenOutput hook, readFile content is screened before it returns to the model', async () => {
    const { deps } = makeDeps({ screenOutput: async (t) => `[SCREENED]${t}` });
    const result = await readSandboxFile({ path: 'a.txt', ctx: makeCtx(), deps });
    expect(result).toMatchObject({ success: true });
    if (result.success) expect(result.content).toBe('[SCREENED]file-contents');
  });
});

/** A clock that only advances when `advance()` is called — lets a test simulate
 * exactly how long the "machine" was active without depending on how many
 * incidental `now()` reads happen elsewhere (audit timestamps, etc). */
function makeMutableClock(startMs: number) {
  let t = startMs;
  return { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
}

function makeBilling(over: Partial<SandboxRunDeps['billing']> = {}): {
  billing: NonNullable<SandboxRunDeps['billing']>;
  resolvePayerIdCalls: Array<{ tenantId: string; machinePageId?: string }>;
  gateCalls: Array<{ payerId: string }>;
  trackUsageCalls: Array<{ payerId: string; holdId?: string; activeSeconds: number; pageId?: string }>;
  releaseHoldCalls: string[];
} {
  const resolvePayerIdCalls: Array<{ tenantId: string; machinePageId?: string }> = [];
  const gateCalls: Array<{ payerId: string }> = [];
  const trackUsageCalls: Array<{ payerId: string; holdId?: string; activeSeconds: number; pageId?: string }> = [];
  const releaseHoldCalls: string[] = [];
  const billing: NonNullable<SandboxRunDeps['billing']> = {
    resolvePayerId: async (input) => {
      resolvePayerIdCalls.push(input);
      return input.tenantId;
    },
    gate: async (input) => {
      gateCalls.push(input);
      return { allowed: true, holdId: 'hold-1' };
    },
    trackUsage: async (input) => {
      trackUsageCalls.push(input);
    },
    releaseHold: async (holdId) => {
      releaseHoldCalls.push(holdId);
    },
    ...over,
  };
  return { billing, resolvePayerIdCalls, gateCalls, trackUsageCalls, releaseHoldCalls };
}

describe('runBashInSandbox — machine billing (Terminal Epic 3)', () => {
  it('given no billing deps, runs unmetered (no gate, no trackUsage, no releaseHold)', async () => {
    const { deps } = makeDeps();
    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx(), deps });
    expect(result).toMatchObject({ success: true });
  });

  it('places a hold BEFORE the machine is acquired, keyed to the resolved payerId', async () => {
    const { billing, gateCalls } = makeBilling();
    const { deps } = makeDeps({ billing });
    await runBashInSandbox({ command: 'echo hi', ctx: makeCtx({ tenantId: 'owner-42' }), deps });
    expect(gateCalls).toEqual([{ payerId: 'owner-42' }]);
  });

  it('on a successful run, settles EXACTLY one usage row via trackUsage with the real active-window seconds and holdId, and never calls releaseHold', async () => {
    const clock = makeMutableClock(new Date('2026-06-01T12:00:00.000Z').getTime());
    const sandbox = makeSandbox({
      runCommand: async () => {
        clock.advance(5000); // the "machine" was active for 5s running this command
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
    });
    const { billing, trackUsageCalls, releaseHoldCalls } = makeBilling();
    const { deps } = makeDeps({ billing, reconnect: async () => sandbox, now: clock.now });

    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx({ tenantId: 'owner-42' }), deps });

    expect(result).toMatchObject({ success: true });
    expect(trackUsageCalls).toEqual([{ payerId: 'owner-42', holdId: 'hold-1', activeSeconds: 5 }]);
    expect(releaseHoldCalls).toEqual([]);
  });

  it('given the gate denies (insufficient credits), fails credit_exhausted and never acquires the machine', async () => {
    let acquireCalls = 0;
    const { billing } = makeBilling({
      gate: async () => ({ allowed: false, reason: 'insufficient_balance' }),
    });
    const { deps } = makeDeps({
      billing,
      acquireSandbox: async () => {
        acquireCalls += 1;
        return { ok: true, sandboxId: 'sbx-1', resumed: false };
      },
    });
    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx(), deps });
    expect(result).toMatchObject({ success: false, reason: 'credit_exhausted' });
    expect(acquireCalls).toBe(0);
  });

  it('given a forced execution error, releases the hold and records NO usage row (no ledger row)', async () => {
    const sandbox = makeSandbox({
      runCommand: async () => {
        throw new Error('sandbox crashed');
      },
    });
    const { billing, trackUsageCalls, releaseHoldCalls } = makeBilling();
    const { deps } = makeDeps({ billing, reconnect: async () => sandbox });

    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx(), deps });

    expect(result).toMatchObject({ success: false, reason: 'execution_failed' });
    expect(trackUsageCalls).toEqual([]);
    expect(releaseHoldCalls).toEqual(['hold-1']);
  });

  it('given a quota concurrency denial AFTER the hold was placed, releases the hold with no usage row', async () => {
    const { billing, trackUsageCalls, releaseHoldCalls } = makeBilling();
    const { deps } = makeDeps({
      billing,
      quota: { acquireSlot: () => false, releaseSlot: () => {} },
    });

    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx(), deps });

    expect(result).toMatchObject({ success: false, reason: 'concurrency_limit' });
    expect(trackUsageCalls).toEqual([]);
    expect(releaseHoldCalls).toEqual(['hold-1']);
  });

  it("for an 'own' machine, resolves machinePageId from agentPageId and forwards both to billing.resolvePayerId", async () => {
    const { billing, resolvePayerIdCalls } = makeBilling();
    const { deps } = makeDeps({ billing });

    await runBashInSandbox({
      command: 'echo hi',
      ctx: makeCtx({ tenantId: 'owner-1', agentPageId: 'own-agent-page' }),
      deps,
    });

    expect(resolvePayerIdCalls).toEqual([{ tenantId: 'owner-1', machinePageId: 'own-agent-page' }]);
  });

  it("for an 'existing' machine, resolves machinePageId from the ACTIVE machine's terminalId (not the agent's own page)", async () => {
    const { billing, resolvePayerIdCalls } = makeBilling();
    const { deps } = makeDeps({ billing });

    await runBashInSandbox({
      command: 'echo hi',
      ctx: makeCtx({
        tenantId: 'acting-user',
        agentPageId: 'own-agent-page',
        activeMachine: { kind: 'existing', terminalId: 'other-terminal-page' },
      }),
      deps,
    });

    expect(resolvePayerIdCalls).toEqual([
      { tenantId: 'acting-user', machinePageId: 'other-terminal-page' },
    ]);
  });

  it("forwards the resolved machinePageId as pageId to trackUsage, so usage-breakdown can attribute cost to the right machine", async () => {
    const clock = makeMutableClock(new Date('2026-06-01T12:00:00.000Z').getTime());
    const sandbox = makeSandbox({
      runCommand: async () => {
        clock.advance(3000);
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
    });
    const { billing, trackUsageCalls } = makeBilling();
    const { deps } = makeDeps({ billing, reconnect: async () => sandbox, now: clock.now });

    await runBashInSandbox({
      command: 'echo hi',
      ctx: makeCtx({
        tenantId: 'acting-user',
        activeMachine: { kind: 'existing', terminalId: 'other-terminal-page' },
      }),
      deps,
    });

    expect(trackUsageCalls).toEqual([
      { payerId: 'acting-user', holdId: 'hold-1', activeSeconds: 3, pageId: 'other-terminal-page' },
    ]);
  });

  it("gates and settles usage against the PAYER resolvePayerId returns, not the raw tenantId, when they differ (owner-pays for a machine owned by someone else)", async () => {
    const clock = makeMutableClock(new Date('2026-06-01T12:00:00.000Z').getTime());
    const sandbox = makeSandbox({
      runCommand: async () => {
        clock.advance(2000);
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
    });
    const { billing, gateCalls, trackUsageCalls } = makeBilling({
      resolvePayerId: async () => 'real-owner-99',
    });
    const { deps } = makeDeps({ billing, reconnect: async () => sandbox, now: clock.now });

    const result = await runBashInSandbox({
      command: 'echo hi',
      ctx: makeCtx({
        tenantId: 'acting-user',
        activeMachine: { kind: 'existing', terminalId: 'other-terminal-page' },
      }),
      deps,
    });

    expect(result).toMatchObject({ success: true });
    expect(gateCalls).toEqual([{ payerId: 'real-owner-99' }]);
    expect(trackUsageCalls).toEqual([
      { payerId: 'real-owner-99', holdId: 'hold-1', activeSeconds: 2, pageId: 'other-terminal-page' },
    ]);
  });
});
