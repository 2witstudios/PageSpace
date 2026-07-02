import { describe, it, expect } from 'vitest';

// The factory is provider-agnostic and imports no DB or backing-provider SDK, so
// it is exercised directly with injected fakes (the production wiring + the Fly
// Sprites driver live in sandbox-tools-runtime.ts).
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
    acquireSandbox: async () => ({ ok: true, sandboxId: 'sbx', resumed: false }),
    reconnect: async () => ({
      sandboxId: 'sbx',
      runCommand: async () => ({ exitCode: 0, stdout: 'hi', stderr: '' }),
      writeFiles: async () => {},
      readFileToBuffer: async () => Buffer.from('data'),
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

  it('bash: given an unresolvable context, should surface the resolver error without running', async () => {
    let acquired = false;
    const runDeps = fakeRunDeps();
    runDeps.acquireSandbox = async () => {
      acquired = true;
      return { ok: true, sandboxId: 'sbx', resumed: false };
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

  it('bash: given the gate denies, should surface the gate error without provisioning', async () => {
    let acquired = false;
    const runDeps = fakeRunDeps();
    runDeps.acquireSandbox = async () => {
      acquired = true;
      return { ok: true, sandboxId: 'sbx', resumed: false };
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

  it('writeFile: given the gate denies, should not write', async () => {
    let wrote = false;
    const runDeps = fakeRunDeps();
    runDeps.reconnect = async () => ({
      sandboxId: 'sbx',
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      writeFiles: async () => {
        wrote = true;
      },
      readFileToBuffer: async () => Buffer.from(''),
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

  it('writeFile: should delegate and report bytes written', async () => {
    const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate });
    const result = await exec(tools.writeFile, { path: 'a.txt', content: 'hello' }, {});
    expect(result).toMatchObject({ success: true, path: 'a.txt', bytesWritten: 5 });
  });

  it('readFile: should delegate and return file contents', async () => {
    const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate });
    const result = await exec(tools.readFile, { path: 'a.txt' }, {});
    expect(result).toMatchObject({ success: true, path: 'a.txt', content: 'data' });
  });

  it('bash inputSchema: should reject an empty command', () => {
    const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate });
    const schema = tools.bash.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ command: '' }).success).toBe(false);
    expect(schema.safeParse({ command: 'ls' }).success).toBe(true);
  });

  describe('schema strictness', () => {
    function schemaOf(tools: ReturnType<typeof createSandboxTools>, name: keyof ReturnType<typeof createSandboxTools>) {
      return tools[name].inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    }

    it('writeFile inputSchema: given an unrecognized cwd field, should reject instead of silently dropping it', () => {
      const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate });
      const schema = schemaOf(tools, 'writeFile');
      expect(schema.safeParse({ path: 'a.txt', content: 'x', cwd: 'PageSpace' }).success).toBe(false);
      expect(schema.safeParse({ path: 'a.txt', content: 'x' }).success).toBe(true);
    });

    it('readFile inputSchema: given an unrecognized cwd field, should reject instead of silently dropping it', () => {
      const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate });
      const schema = schemaOf(tools, 'readFile');
      expect(schema.safeParse({ path: 'a.txt', cwd: 'PageSpace' }).success).toBe(false);
      expect(schema.safeParse({ path: 'a.txt' }).success).toBe(true);
    });

    it('editFile inputSchema: given an unrecognized cwd field, should reject instead of silently dropping it', () => {
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

  it('editFile: should delegate and report replacements', async () => {
    const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate });
    const result = await exec(tools.editFile, { path: 'a.txt', oldString: 'data', newString: 'X' }, {});
    expect(result).toMatchObject({ success: true, path: 'a.txt', replacements: 1 });
  });

  it('editFile: given the gate denies, should not edit', async () => {
    let wrote = false;
    const runDeps = fakeRunDeps();
    runDeps.reconnect = async () => ({
      sandboxId: 'sbx',
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      writeFiles: async () => {
        wrote = true;
      },
      readFileToBuffer: async () => Buffer.from('data'),
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

  it('editFile inputSchema: should require path/oldString/newString and accept replaceAll', () => {
    const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate });
    const schema = tools.editFile.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ path: 'a', oldString: 'x', newString: 'y' }).success).toBe(true);
    expect(schema.safeParse({ path: 'a', oldString: 'x', newString: 'y', replaceAll: true }).success).toBe(true);
    expect(schema.safeParse({ path: 'a', oldString: 'x' }).success).toBe(false);
  });
});
