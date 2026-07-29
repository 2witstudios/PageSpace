import { describe, it, expect, vi } from 'vitest';
import {
  runBashInSandbox,
  writeSandboxFile,
  readSandboxFile,
  editSandboxFile,
  MAX_WRITE_BYTES,
  CHECKPOINT_TIMEOUT_MS,
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
    spriteInstanceId: null,
    runCommand: async (): Promise<SandboxRunResult> => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
    writeFiles: async () => {},
    readFileToBuffer: async () => Buffer.from('file-contents'),
    createCheckpoint: async () => {},
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

  it('given a ctx, should thread agentPageId/conversationId onto the acquireSandbox request', async () => {
    const seen: unknown[] = [];
    const { deps } = makeDeps({
      acquireSandbox: async (input) => {
        seen.push(input);
        return { ok: true, sandboxId: 'sbx-1', resumed: false };
      },
    });
    await runBashInSandbox({
      command: 'echo hi',
      ctx: makeCtx({ agentPageId: 'agent-1', conversationId: 'c1' }),
      deps,
    });
    expect(seen).toEqual([
      expect.objectContaining({ agentPageId: 'agent-1', conversationId: 'c1' }),
    ]);
  });

  it('given no_machine from acquire (e.g. a session with no backing page), should deny no_machine and release the slot', async () => {
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

  it('given a plan-ceiling refusal, should name the ceiling rather than a generic provisioning fault', async () => {
    const { deps, slots } = makeDeps({
      acquireSandbox: async () => ({ ok: false as const, reason: 'provision_failed' as const, cause: 'session_limit_reached' }),
    });

    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx(), deps });

    expect(result).toMatchObject({ success: false, reason: 'session_limit_reached' });
    // The distinction that matters to the agent reading this: a provisioning
    // fault is worth retrying, a plan ceiling is not.
    if (result.success) throw new Error('unreachable');
    expect(result.error).toContain('Retrying will not help');
    expect(slots.released).toBe(1);
  });

  it('given a provisioning failure with NO stated cause, should stay generic', async () => {
    const { deps } = makeDeps({
      acquireSandbox: async () => ({ ok: false as const, reason: 'provision_failed' as const }),
    });

    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx(), deps });

    expect(result).toMatchObject({ success: false, reason: 'provision_failed' });
  });

  it('given a successful run, should return output, audit the run, and release the slot', async () => {
    const { deps, audits, slots } = makeDeps();
    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx(), deps });
    expect(result).toEqual({ success: true, stdout: 'ok', stderr: '', exitCode: 0, truncated: false });
    expect(audits[0]).toMatchObject({ exitCode: 0, code: 'echo hi', anomaly: undefined });
    expect(slots.released).toBe(1);
  });

  it('given a successful run, should notify the session\'s shell activity feed', async () => {
    const notified: unknown[] = [];
    const { deps } = makeDeps({
      acquireSandbox: async () => ({ ok: true, sandboxId: 'sbx-1', resumed: false, pageId: 'terminal-page-1' }),
      notifyShellActivity: async (input) => {
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
        sessionId: 'c1',
        command: 'echo hi',
        output: 'ok',
        exitCode: 0,
        agentLabel: 'Agent Bob',
      },
    ]);
  });

  it('given a successful run, should measure the SESSION\'s storage with the live sandbox', async () => {
    const measured: Array<{ sandbox: unknown; sessionId: string }> = [];
    const { deps } = makeDeps({
      acquireSandbox: async () => ({ ok: true, sandboxId: 'sbx-1', resumed: false, pageId: 'terminal-page-1' }),
      measureStorage: async (input) => {
        measured.push(input);
      },
    });
    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx(), deps });
    expect(result).toMatchObject({ success: true });
    // Fire-and-forget: give the microtask a tick to run.
    await Promise.resolve();
    expect(measured).toHaveLength(1);
    expect(measured[0].sessionId).toBe('c1');
  });

  it('should measure AFTER the command runs, not before — the whole point of the seam', async () => {
    // The bytes worth billing are the ones the op just wrote. Measuring first
    // records the pre-write footprint and then lets the per-session throttle
    // suppress the post-write measurement, so a run that writes gigabytes stays
    // invisible until the throttle lapses. This ordering is why the seam fires
    // from `release` (a `finally`, after the op) rather than from acquisition.
    const order: string[] = [];
    const { deps } = makeDeps({
      acquireSandbox: async () => ({ ok: true, sandboxId: 'sbx-1', resumed: false, pageId: 'p1' }),
      reconnect: async () =>
        makeSandbox({
          runCommand: async () => {
            order.push('command');
            return { exitCode: 0, stdout: 'ok', stderr: '' };
          },
        }),
      measureStorage: async () => {
        order.push('measure');
      },
    });

    await runBashInSandbox({ command: 'echo hi', ctx: makeCtx(), deps });
    await Promise.resolve();

    expect(order).toEqual(['command', 'measure']);
  });

  it('given a GLOBAL-ASSISTANT session (no agent page), should still measure — its bytes bill too', async () => {
    // Same page-shaped assumption that had excluded these sessions from the
    // activity feed: the old gate was `acquired.pageId`, which they never have.
    const measured: Array<{ sessionId: string }> = [];
    const { deps } = makeDeps({
      acquireSandbox: async () => ({ ok: true, sandboxId: 'sbx-1', resumed: false }),
      measureStorage: async (input) => {
        measured.push(input);
      },
    });
    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx({ agentPageId: undefined }), deps });
    expect(result).toMatchObject({ success: true });
    await Promise.resolve();
    expect(measured[0]?.sessionId).toBe('c1');
  });

  it('given no conversation id, should never measure — there is no session to attribute bytes to', async () => {
    const measured: unknown[] = [];
    const { deps } = makeDeps({
      acquireSandbox: async () => ({ ok: true, sandboxId: 'sbx-1', resumed: false }),
      measureStorage: async (input) => {
        measured.push(input);
      },
    });
    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx({ conversationId: undefined }), deps });
    expect(result).toMatchObject({ success: true });
    await Promise.resolve();
    expect(measured).toEqual([]);
  });

  it('given a throwing storage measurement, should still return the successful result (best-effort)', async () => {
    const { deps } = makeDeps({
      acquireSandbox: async () => ({ ok: true, sandboxId: 'sbx-1', resumed: false, pageId: 'terminal-page-1' }),
      measureStorage: async () => {
        throw new Error('measure failed');
      },
    });
    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx(), deps });
    expect(result).toEqual({ success: true, stdout: 'ok', stderr: '', exitCode: 0, truncated: false });
    await Promise.resolve();
  });

  it('given a GLOBAL-ASSISTANT session (no agent page), should still notify — it has a sandbox too', async () => {
    // The old gate was the agent pageId, which a global-assistant session does
    // not have, so this whole class of session was silently excluded from the
    // feed. The session id is the address now, and every session has one.
    const notified: Array<{ sessionId: string }> = [];
    const { deps } = makeDeps({
      acquireSandbox: async () => ({ ok: true, sandboxId: 'sbx-1', resumed: false }),
      notifyShellActivity: async (input) => {
        notified.push(input);
      },
    });
    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx({ agentPageId: undefined }), deps });
    expect(result).toMatchObject({ success: true });
    expect(notified[0]?.sessionId).toBe('c1');
  });

  it('given no conversation id, should never call the activity feed — there is nothing to address', async () => {
    const notified: unknown[] = [];
    const { deps } = makeDeps({
      acquireSandbox: async () => ({ ok: true, sandboxId: 'sbx-1', resumed: false }),
      notifyShellActivity: async (input) => {
        notified.push(input);
      },
    });
    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx({ conversationId: undefined }), deps });
    expect(result).toMatchObject({ success: true });
    expect(notified).toEqual([]);
  });

  it('given a throwing activity feed, should still return the successful result', async () => {
    const { deps } = makeDeps({
      acquireSandbox: async () => ({ ok: true, sandboxId: 'sbx-1', resumed: false, pageId: 'terminal-page-1' }),
      notifyShellActivity: async () => {
        throw new Error('feed down');
      },
    });
    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx(), deps });
    expect(result).toEqual({ success: true, stdout: 'ok', stderr: '', exitCode: 0, truncated: false });
  });

  it('given a slow-to-resolve activity feed, should NOT block the tool result on it (fire-and-forget)', async () => {
    let releaseFeed: (() => void) | undefined;
    const feedGate = new Promise<void>((resolve) => {
      releaseFeed = resolve;
    });
    const { deps } = makeDeps({
      acquireSandbox: async () => ({ ok: true, sandboxId: 'sbx-1', resumed: false, pageId: 'terminal-page-1' }),
      notifyShellActivity: async () => {
        await feedGate; // Never resolves during this test unless we release it.
      },
    });

    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx(), deps });

    expect(result).toMatchObject({ success: true });
    releaseFeed?.(); // Avoid leaving a dangling unresolved promise after the test.
  });

  it('given both stdout and stderr, should combine them for the activity feed instead of dropping stderr', async () => {
    const notified: Array<{ output: string }> = [];
    const { deps } = makeDeps({
      acquireSandbox: async () => ({ ok: true, sandboxId: 'sbx-1', resumed: false, pageId: 'terminal-page-1' }),
      reconnect: async () =>
        makeSandbox({ runCommand: async () => ({ exitCode: 0, stdout: 'out-line', stderr: 'err-line' }) }),
      notifyShellActivity: async (input) => {
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
      notifyShellActivity: async (input) => {
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

describe('runBashInSandbox — pre-batch checkpoint (Sprites Platform Alignment 5-2)', () => {
  function makeCheckpointDeps(over: Partial<NonNullable<SandboxRunDeps['checkpoint']>> = {}) {
    const state = new Map<string, { lastCheckpointAt: Date | null; lastCheckpointTurnId: string | null }>();
    const created: Array<{ sandboxId: string; comment: string }> = [];
    const checkpoint: NonNullable<SandboxRunDeps['checkpoint']> = {
      isEnabled: () => true,
      getState: (sandboxId) => state.get(sandboxId) ?? { lastCheckpointAt: null, lastCheckpointTurnId: null },
      recordCheckpoint: (sandboxId, s) => {
        state.set(sandboxId, s);
      },
      createCheckpoint: async ({ sandbox, comment }) => {
        created.push({ sandboxId: sandbox.sandboxId, comment });
      },
      ...over,
    };
    return { checkpoint, created, state };
  }

  it('given the flag on and a turnId, should checkpoint before the command runs, tagged with the turn', async () => {
    const order: string[] = [];
    const { checkpoint, created } = makeCheckpointDeps({
      createCheckpoint: async ({ sandbox, comment }) => {
        order.push('checkpoint');
        created.push({ sandboxId: sandbox.sandboxId, comment });
      },
    });
    const { deps } = makeDeps({
      checkpoint,
      reconnect: async () =>
        makeSandbox({
          runCommand: async () => {
            order.push('run');
            return { exitCode: 0, stdout: 'ok', stderr: '' };
          },
        }),
    });
    const result = await runBashInSandbox({ command: 'rm -rf /workspace', ctx: makeCtx({ turnId: 'turn-1' }), deps });
    expect(result).toMatchObject({ success: true });
    expect(created).toEqual([{ sandboxId: 'sbx-1', comment: 'pagespace-pre-agent-turn-1' }]);
    expect(order).toEqual(['checkpoint', 'run']);
  });

  it('given the flag off, should never call createCheckpoint', async () => {
    const { checkpoint, created } = makeCheckpointDeps({ isEnabled: () => false });
    const { deps } = makeDeps({ checkpoint });
    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx({ turnId: 'turn-1' }), deps });
    expect(result).toMatchObject({ success: true });
    expect(created).toEqual([]);
  });

  it('given no turnId on ctx, should skip checkpointing entirely (no turn boundary to key the throttle on)', async () => {
    const { checkpoint, created } = makeCheckpointDeps();
    const { deps } = makeDeps({ checkpoint });
    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx({ turnId: undefined }), deps });
    expect(result).toMatchObject({ success: true });
    expect(created).toEqual([]);
  });

  it('given repeated batches within the SAME turn, should checkpoint at most once', async () => {
    const { checkpoint, created } = makeCheckpointDeps();
    const { deps } = makeDeps({ checkpoint });
    await runBashInSandbox({ command: 'echo one', ctx: makeCtx({ turnId: 'turn-1' }), deps });
    await runBashInSandbox({ command: 'echo two', ctx: makeCtx({ turnId: 'turn-1' }), deps });
    await runBashInSandbox({ command: 'echo three', ctx: makeCtx({ turnId: 'turn-1' }), deps });
    expect(created).toHaveLength(1);
  });

  it('given a NEW turn well after the first, should checkpoint again', async () => {
    const { checkpoint, created } = makeCheckpointDeps();
    const { deps: deps1 } = makeDeps({ checkpoint, now: () => new Date('2026-07-12T12:00:00.000Z') });
    await runBashInSandbox({ command: 'echo one', ctx: makeCtx({ turnId: 'turn-1' }), deps: deps1 });

    const { deps: deps2 } = makeDeps({ checkpoint, now: () => new Date('2026-07-12T12:05:00.000Z') });
    await runBashInSandbox({ command: 'echo two', ctx: makeCtx({ turnId: 'turn-2' }), deps: deps2 });

    expect(created).toHaveLength(2);
    expect(created[1]).toEqual({ sandboxId: 'sbx-1', comment: 'pagespace-pre-agent-turn-2' });
  });

  // Regression test for a P2 finding on PR #2025 (chatgpt-codex-connector): an
  // earlier revision's pure policy suppressed a NEW turn's checkpoint if it
  // fell within a time-based throttle window of a prior, DIFFERENT turn's
  // checkpoint — so two legitimate turns close together (an ordinary rapid
  // back-and-forth) would leave only the older turn's restore point on
  // record, silently discarding the newer turn's real work on a later
  // restore. Exercised here through the full runBashInSandbox path, not just
  // the pure function, with `now` identical across both turns (the most
  // adversarial case for a time-based throttle).
  it('given a NEW turn moments after a different turn was checkpointed, should still checkpoint (no cross-turn interval suppression)', async () => {
    const { checkpoint, created } = makeCheckpointDeps();
    const sameInstant = () => new Date('2026-07-12T12:00:00.000Z');
    const { deps: deps1 } = makeDeps({ checkpoint, now: sameInstant });
    await runBashInSandbox({ command: 'echo one', ctx: makeCtx({ turnId: 'turn-1' }), deps: deps1 });

    const { deps: deps2 } = makeDeps({ checkpoint, now: sameInstant });
    await runBashInSandbox({ command: 'echo two', ctx: makeCtx({ turnId: 'turn-2' }), deps: deps2 });

    expect(created).toEqual([
      { sandboxId: 'sbx-1', comment: 'pagespace-pre-agent-turn-1' },
      { sandboxId: 'sbx-1', comment: 'pagespace-pre-agent-turn-2' },
    ]);
  });

  it('given checkpoint creation throws, should proceed with the batch (fail-open) and log', async () => {
    const { checkpoint, created } = makeCheckpointDeps({
      createCheckpoint: async () => {
        throw new Error('checkpoint API unavailable');
      },
    });
    const warnings: Array<[string, Record<string, unknown> | undefined]> = [];
    const { deps } = makeDeps({
      checkpoint,
      logger: {
        error: () => {},
        warn: (message, metadata) => {
          warnings.push([message, metadata]);
        },
      },
    });
    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx({ turnId: 'turn-1' }), deps });
    expect(result).toMatchObject({ success: true, stdout: 'ok' });
    expect(created).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0][0]).toMatch(/checkpoint/i);
  });

  it('given no checkpoint dep configured, should run normally (seam fully optional)', async () => {
    const { deps } = makeDeps();
    const result = await runBashInSandbox({ command: 'echo hi', ctx: makeCtx({ turnId: 'turn-1' }), deps });
    expect(result).toMatchObject({ success: true });
  });

  it('does not record a checkpoint when the SDK call itself fails (a later batch in the same turn may retry)', async () => {
    let attempts = 0;
    const { checkpoint, created } = makeCheckpointDeps({
      createCheckpoint: async ({ sandbox, comment }) => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient failure');
        created.push({ sandboxId: sandbox.sandboxId, comment });
      },
    });
    const { deps } = makeDeps({ checkpoint, logger: { error: () => {}, warn: () => {} } });
    await runBashInSandbox({ command: 'echo one', ctx: makeCtx({ turnId: 'turn-1' }), deps });
    await runBashInSandbox({ command: 'echo two', ctx: makeCtx({ turnId: 'turn-1' }), deps });
    expect(attempts).toBe(2);
    expect(created).toHaveLength(1);
  });

  // Regression test for a P2 finding on PR #2025 (chatgpt-codex-connector): a
  // checkpoint call that never settles must never block the batch — the
  // fail-open guarantee documented on maybeCheckpointBeforeBatch would
  // otherwise be violated by an indefinitely hung checkpoint stream.
  it('given a checkpoint call that never settles, still proceeds with the batch after CHECKPOINT_TIMEOUT_MS (fail-open)', async () => {
    vi.useFakeTimers();
    try {
      const { checkpoint, created } = makeCheckpointDeps({
        createCheckpoint: () => new Promise(() => {}), // never resolves
      });
      const warnings: Array<[string, Record<string, unknown> | undefined]> = [];
      const { deps } = makeDeps({
        checkpoint,
        logger: {
          error: () => {},
          warn: (message, metadata) => {
            warnings.push([message, metadata]);
          },
        },
      });

      const resultPromise = runBashInSandbox({ command: 'echo hi', ctx: makeCtx({ turnId: 'turn-1' }), deps });
      const assertion = expect(resultPromise).resolves.toMatchObject({ success: true, stdout: 'ok' });
      await vi.advanceTimersByTimeAsync(CHECKPOINT_TIMEOUT_MS);
      await assertion;

      expect(created).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0][0]).toMatch(/checkpoint/i);
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression test for a P2 finding on PR #2025 (2 independent review
  // agents): the AI SDK can execute multiple tool calls from one agent step
  // concurrently, so two bash calls in the SAME turn must still checkpoint
  // at most once even when dispatched together (Promise.all), not just when
  // dispatched sequentially (already covered above).
  it('given two bash calls in the SAME turn dispatched concurrently, still checkpoints at most once', async () => {
    let createCalls = 0;
    let releaseCheckpoint: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve;
    });
    const { checkpoint, created } = makeCheckpointDeps({
      createCheckpoint: async ({ sandbox, comment }) => {
        createCalls += 1;
        await gate; // hold both concurrent callers here until released together
        created.push({ sandboxId: sandbox.sandboxId, comment });
      },
    });
    const { deps } = makeDeps({ checkpoint });

    const first = runBashInSandbox({ command: 'echo one', ctx: makeCtx({ turnId: 'turn-1' }), deps });
    const second = runBashInSandbox({ command: 'echo two', ctx: makeCtx({ turnId: 'turn-1' }), deps });

    // Give both calls a chance to reach (and coalesce on) the checkpoint attempt.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(createCalls).toBe(1); // coalesced — not 2, even though both calls raced past the throttle check

    releaseCheckpoint?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toMatchObject({ success: true });
    expect(secondResult).toMatchObject({ success: true });
    expect(created).toHaveLength(1);
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
  resolvePayerIdCalls: Array<{ tenantId: string; agentPageId?: string }>;
  gateCalls: Array<{ payerId: string }>;
  trackUsageCalls: Array<{ payerId: string; holdId?: string; activeSeconds: number; pageId?: string }>;
  releaseHoldCalls: string[];
} {
  const resolvePayerIdCalls: Array<{ tenantId: string; agentPageId?: string }> = [];
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

  it("resolves agentPageId from ctx.agentPageId and forwards both to billing.resolvePayerId", async () => {
    const { billing, resolvePayerIdCalls } = makeBilling();
    const { deps } = makeDeps({ billing });

    await runBashInSandbox({
      command: 'echo hi',
      ctx: makeCtx({ tenantId: 'owner-1', agentPageId: 'own-agent-page' }),
      deps,
    });

    expect(resolvePayerIdCalls).toEqual([{ tenantId: 'owner-1', agentPageId: 'own-agent-page' }]);
  });

  it("forwards the resolved agentPageId as pageId to trackUsage, so usage-breakdown can attribute cost to the right agent page", async () => {
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
        agentPageId: 'other-terminal-page',
      }),
      deps,
    });

    expect(trackUsageCalls).toEqual([
      { payerId: 'acting-user', holdId: 'hold-1', activeSeconds: 3, pageId: 'other-terminal-page' },
    ]);
  });

  it("gates and settles usage against the PAYER resolvePayerId returns, not the raw tenantId, when they differ (owner-pays for a page owned by someone else)", async () => {
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
        agentPageId: 'other-terminal-page',
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
