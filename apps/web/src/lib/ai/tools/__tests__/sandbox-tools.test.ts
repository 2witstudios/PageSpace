import { describe, it, expect } from 'vitest';

// The factory is provider-agnostic and imports no DB or backing-provider SDK, so
// it is exercised directly with injected fakes (the production wiring + the Fly
// Sprites driver live in sandbox-tools-runtime.ts). The session sandbox needs no
// machine directory: a conversation has exactly one sandbox, so the factory is
// schema + context resolution + gate + delegation and nothing else.
import { createSandboxTools, type ResolveSandboxContext, type SandboxGate } from '../sandbox-tools';
import type { SandboxRunDeps, SandboxActorContext } from '@pagespace/lib/services/sandbox/tool-runners';

const ctx: SandboxActorContext = {
  userId: 'u1',
  tenantId: 't1',
  driveId: 'd1',
  conversationId: 'c1',
  actorEmail: 'u1@example.com',
  tier: 'pro',
};

const okResolve: ResolveSandboxContext = async () => ctx;
const okGate: SandboxGate = async () => ({ ok: true });

function fakeRunDeps(): SandboxRunDeps {
  return {
    isEnabled: () => true,
    acquireSandbox: async () => ({ ok: true, sandboxId: 'sbx', resumed: false, sessionId: 'ws-1' }),
    reconnect: async () => ({
      sandboxId: 'sbx',
      spriteInstanceId: null,
      runCommand: async () => ({ exitCode: 0, stdout: 'hi', stderr: '' }),
      writeFiles: async () => {},
      readFileToBuffer: async () => Buffer.from('data'),
      createCheckpoint: async () => {},
    }),
    quota: {
      acquireSlot: () => true,
      releaseSlot: () => {},
    },
    buildEnv: () => ({}),
    audit: async () => {},
    now: () => new Date('2026-06-01T00:00:00Z'),
  };
}

function exec(tool: { execute?: unknown }, args: unknown, context: unknown) {
  const fn = tool.execute as (a: unknown, o: unknown) => Promise<unknown>;
  return fn(args, { experimental_context: context });
}

describe('createSandboxTools', () => {
  it('bash: given a resolvable context, should delegate to the runner and return its result', async () => {
    const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate });
    const result = await exec(tools.bash, { command: 'echo hi' }, {});
    expect(result).toMatchObject({ success: true, stdout: 'hi', exitCode: 0 });
  });

  it('bash: should pass command/cwd/timeoutMs straight through to the sandbox run', async () => {
    const seenRuns: Array<{ cmd: string; args: string[]; cwd?: string; timeoutMs?: number }> = [];
    const runDeps = fakeRunDeps();
    runDeps.reconnect = async () => ({
      sandboxId: 'sbx',
      spriteInstanceId: null,
      runCommand: async (args: { cmd: string; args: string[]; cwd?: string; timeoutMs?: number }) => {
        seenRuns.push(args);
        return { exitCode: 0, stdout: 'hi', stderr: '' };
      },
      writeFiles: async () => {},
      readFileToBuffer: async () => Buffer.from('data'),
      createCheckpoint: async () => {},
    });
    const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate });
    const result = await exec(tools.bash, { command: 'echo hi', cwd: '/workspace/repo', timeoutMs: 5000 }, {});
    expect(result).toMatchObject({ success: true });
    expect(seenRuns).toEqual([
      expect.objectContaining({
        cmd: 'sh',
        args: ['-c', 'echo hi'],
        cwd: '/workspace/repo',
        timeoutMs: 5000,
      }),
    ]);
  });

  it('bash: given no explicit cwd, should run at the sandbox root (the runner default)', async () => {
    const seenCwds: Array<string | undefined> = [];
    const runDeps = fakeRunDeps();
    runDeps.reconnect = async () => ({
      sandboxId: 'sbx',
      spriteInstanceId: null,
      runCommand: async (args: { cwd?: string }) => {
        seenCwds.push(args.cwd);
        return { exitCode: 0, stdout: 'hi', stderr: '' };
      },
      writeFiles: async () => {},
      readFileToBuffer: async () => Buffer.from('data'),
      createCheckpoint: async () => {},
    });
    const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate });
    const result = await exec(tools.bash, { command: 'echo hi' }, { userId: 'u1' });
    expect(result).toMatchObject({ success: true });
    expect(seenCwds).toEqual(['/workspace']);
  });

  it('bash: given an unresolvable context, should surface the resolver error without running', async () => {
    let acquired = false;
    const runDeps = fakeRunDeps();
    runDeps.acquireSandbox = async () => {
      acquired = true;
      return { ok: true, sandboxId: 'sbx', resumed: false, sessionId: 'ws-1' };
    };
    const tools = createSandboxTools({
      runDeps,
      resolveContext: async () => ({ error: 'no drive' }),
      gate: okGate,
    });
    const result = await exec(tools.bash, { command: 'echo hi' }, {});
    expect(result).toEqual({ success: false, error: 'no drive' });
    expect(acquired).toBe(false);
  });

  it('bash: given the gate denies, should surface the gate error (with retryAfter) without provisioning', async () => {
    let acquired = false;
    const runDeps = fakeRunDeps();
    runDeps.acquireSandbox = async () => {
      acquired = true;
      return { ok: true, sandboxId: 'sbx', resumed: false, sessionId: 'ws-1' };
    };
    const tools = createSandboxTools({
      runDeps,
      resolveContext: okResolve,
      gate: async () => ({ ok: false, reason: 'concurrency_limit', error: 'too many runs', retryAfter: 30 }),
    });
    const result = await exec(tools.bash, { command: 'echo hi' }, {});
    expect(result).toEqual({ success: false, error: 'too many runs', retryAfter: 30 });
    expect(acquired).toBe(false);
  });

  it('bash: given the gate denies without a retry hint, should not fabricate a retryAfter field', async () => {
    const tools = createSandboxTools({
      runDeps: fakeRunDeps(),
      resolveContext: okResolve,
      gate: async () => ({ ok: false, reason: 'kill_switch_off', error: 'disabled' }),
    });
    const result = await exec(tools.bash, { command: 'echo hi' }, {});
    expect(result).toEqual({ success: false, error: 'disabled' });
  });

  it('writeFile: given the gate denies, should not write', async () => {
    let wrote = false;
    const runDeps = fakeRunDeps();
    runDeps.reconnect = async () => ({
      sandboxId: 'sbx',
      spriteInstanceId: null,
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      writeFiles: async () => {
        wrote = true;
      },
      readFileToBuffer: async () => Buffer.from(''),
      createCheckpoint: async () => {},
    });
    const tools = createSandboxTools({
      runDeps,
      resolveContext: okResolve,
      gate: async () => ({ ok: false, reason: 'kill_switch_off', error: 'disabled' }),
    });
    const result = await exec(tools.writeFile, { path: 'a.txt', content: 'x' }, {});
    expect(result).toEqual({ success: false, error: 'disabled' });
    expect(wrote).toBe(false);
  });

  it('writeFile: should delegate the path/content and report bytes written', async () => {
    const seenWrites: Array<Array<{ path: string; content: string }>> = [];
    const runDeps = fakeRunDeps();
    runDeps.reconnect = async () => ({
      sandboxId: 'sbx',
      spriteInstanceId: null,
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      writeFiles: async (files: Array<{ path: string; content: string }>) => {
        seenWrites.push(files);
      },
      readFileToBuffer: async () => Buffer.from('data'),
      createCheckpoint: async () => {},
    });
    const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate });
    const result = await exec(tools.writeFile, { path: 'a.txt', content: 'hello' }, {});
    expect(result).toMatchObject({ success: true, path: 'a.txt', bytesWritten: 5 });
    // The runner anchors the relative path at the sandbox root — no node/binding cwd.
    expect(seenWrites).toEqual([[{ path: '/workspace/a.txt', content: 'hello' }]]);
  });

  it('readFile: should delegate the path and return file contents', async () => {
    const seenReads: Array<{ path: string }> = [];
    const runDeps = fakeRunDeps();
    runDeps.reconnect = async () => ({
      sandboxId: 'sbx',
      spriteInstanceId: null,
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      writeFiles: async () => {},
      readFileToBuffer: async (args: { path: string }) => {
        seenReads.push(args);
        return Buffer.from('data');
      },
      createCheckpoint: async () => {},
    });
    const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate });
    const result = await exec(tools.readFile, { path: 'a.txt' }, {});
    expect(result).toMatchObject({ success: true, path: 'a.txt', content: 'data' });
    expect(seenReads).toEqual([{ path: '/workspace/a.txt' }]);
  });

  it('readFile: given the gate denies, should not read', async () => {
    let read = false;
    const runDeps = fakeRunDeps();
    runDeps.reconnect = async () => ({
      sandboxId: 'sbx',
      spriteInstanceId: null,
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      writeFiles: async () => {},
      readFileToBuffer: async () => {
        read = true;
        return Buffer.from('data');
      },
      createCheckpoint: async () => {},
    });
    const tools = createSandboxTools({
      runDeps,
      resolveContext: okResolve,
      gate: async () => ({ ok: false, reason: 'kill_switch_off', error: 'disabled' }),
    });
    const result = await exec(tools.readFile, { path: 'a.txt' }, {});
    expect(result).toEqual({ success: false, error: 'disabled' });
    expect(read).toBe(false);
  });

  it('editFile: should delegate oldString/newString and report replacements', async () => {
    const seenWrites: Array<Array<{ path: string; content: string }>> = [];
    const runDeps = fakeRunDeps();
    runDeps.reconnect = async () => ({
      sandboxId: 'sbx',
      spriteInstanceId: null,
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      writeFiles: async (files: Array<{ path: string; content: string }>) => {
        seenWrites.push(files);
      },
      readFileToBuffer: async () => Buffer.from('data'),
      createCheckpoint: async () => {},
    });
    const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate });
    const result = await exec(tools.editFile, { path: 'a.txt', oldString: 'data', newString: 'X' }, {});
    expect(result).toMatchObject({ success: true, path: 'a.txt', replacements: 1 });
    expect(seenWrites).toEqual([[{ path: '/workspace/a.txt', content: 'X' }]]);
  });

  it('editFile: given replaceAll, should replace every occurrence', async () => {
    const seenWrites: Array<Array<{ path: string; content: string }>> = [];
    const runDeps = fakeRunDeps();
    runDeps.reconnect = async () => ({
      sandboxId: 'sbx',
      spriteInstanceId: null,
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      writeFiles: async (files: Array<{ path: string; content: string }>) => {
        seenWrites.push(files);
      },
      readFileToBuffer: async () => Buffer.from('data data'),
      createCheckpoint: async () => {},
    });
    const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate });
    const result = await exec(
      tools.editFile,
      { path: 'a.txt', oldString: 'data', newString: 'X', replaceAll: true },
      {},
    );
    expect(result).toMatchObject({ success: true, replacements: 2 });
    expect(seenWrites).toEqual([[{ path: '/workspace/a.txt', content: 'X X' }]]);
  });

  it('editFile: given the gate denies, should not edit', async () => {
    let wrote = false;
    const runDeps = fakeRunDeps();
    runDeps.reconnect = async () => ({
      sandboxId: 'sbx',
      spriteInstanceId: null,
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      writeFiles: async () => {
        wrote = true;
      },
      readFileToBuffer: async () => Buffer.from('data'),
      createCheckpoint: async () => {},
    });
    const tools = createSandboxTools({
      runDeps,
      resolveContext: okResolve,
      gate: async () => ({ ok: false, reason: 'kill_switch_off', error: 'disabled' }),
    });
    const result = await exec(tools.editFile, { path: 'a.txt', oldString: 'data', newString: 'X' }, {});
    expect(result).toEqual({ success: false, error: 'disabled' });
    expect(wrote).toBe(false);
  });

  it('bash inputSchema: should reject an empty command', () => {
    const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate });
    const schema = tools.bash.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ command: '' }).success).toBe(false);
    expect(schema.safeParse({ command: 'ls' }).success).toBe(true);
  });

  it('bash inputSchema: should accept cwd and a positive integer timeoutMs, rejecting invalid ones', () => {
    const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate });
    const schema = tools.bash.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ command: 'ls', cwd: '/workspace/repo' }).success).toBe(true);
    expect(schema.safeParse({ command: 'ls', timeoutMs: 5000 }).success).toBe(true);
    expect(schema.safeParse({ command: 'ls', timeoutMs: 0 }).success).toBe(false);
    expect(schema.safeParse({ command: 'ls', timeoutMs: 1.5 }).success).toBe(false);
  });

  describe('schema strictness', () => {
    function schemaOf(tools: ReturnType<typeof createSandboxTools>, name: keyof ReturnType<typeof createSandboxTools>) {
      return tools[name].inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    }

    it('writeFile inputSchema: given an unrecognized field, should reject instead of silently dropping it', () => {
      const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate });
      const schema = schemaOf(tools, 'writeFile');
      expect(schema.safeParse({ path: 'a.txt', content: 'x', cwd: 'PageSpace' }).success).toBe(false);
      expect(schema.safeParse({ path: 'a.txt', content: 'x' }).success).toBe(true);
    });

    it('readFile inputSchema: given an unrecognized field, should reject instead of silently dropping it', () => {
      const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate });
      const schema = schemaOf(tools, 'readFile');
      expect(schema.safeParse({ path: 'a.txt', cwd: 'PageSpace' }).success).toBe(false);
      expect(schema.safeParse({ path: 'a.txt' }).success).toBe(true);
    });

    it('editFile inputSchema: given an unrecognized field, should reject instead of silently dropping it', () => {
      const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate });
      const schema = schemaOf(tools, 'editFile');
      expect(schema.safeParse({ path: 'a.txt', oldString: 'x', newString: 'y', cwd: 'PageSpace' }).success).toBe(false);
      expect(schema.safeParse({ path: 'a.txt', oldString: 'x', newString: 'y' }).success).toBe(true);
    });

    it('bash inputSchema: given a legitimate extra-looking but unknown field, should reject it', () => {
      const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate });
      const schema = schemaOf(tools, 'bash');
      expect(schema.safeParse({ command: 'ls', bogus: true }).success).toBe(false);
      expect(schema.safeParse({ command: 'ls', cwd: 'PageSpace' }).success).toBe(true);
    });
  });

  it('editFile inputSchema: should require path/oldString/newString and accept replaceAll', () => {
    const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate });
    const schema = tools.editFile.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ path: 'a', oldString: 'x', newString: 'y' }).success).toBe(true);
    expect(schema.safeParse({ path: 'a', oldString: 'x', newString: 'y', replaceAll: true }).success).toBe(true);
    expect(schema.safeParse({ path: 'a', oldString: 'x' }).success).toBe(false);
  });

  it('should expose exactly the four session tools — no machine directory tools remain', () => {
    const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate });
    expect(Object.keys(tools).sort()).toEqual(['bash', 'editFile', 'readFile', 'writeFile']);
  });
});
