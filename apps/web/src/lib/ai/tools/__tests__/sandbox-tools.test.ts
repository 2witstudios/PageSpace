import { describe, it, expect, vi } from 'vitest';

// The factory is provider-agnostic and imports no DB or backing-provider SDK, so
// it is exercised directly with injected fakes (the production wiring + the Fly
// Sprites driver live in sandbox-tools-runtime.ts).
import { createSandboxTools, nodeScopedPath, type MachineDirectoryDeps, type ResolveSandboxContext, type SandboxGate } from '../sandbox-tools';
import type { SandboxRunDeps, SandboxActorContext } from '@pagespace/lib/services/sandbox/tool-runners';
import type { ToolExecutionContext } from '../../core/types';
import type { MachineNodeHandle, MachineNodeHandleSet } from '@pagespace/lib/services/machines/machine-pane-binding';

/**
 * A machine-bound pane's handle set, as `deriveMachinePaneBinding` produces it.
 * `handles` defaults to `[self]` — the leaf case — because these suites assert
 * self-node behaviour; the cascade set itself is covered by the pure core's own
 * suite (packages/lib machines/__tests__/machine-pane-binding.test.ts).
 */
function boundTo(
  machineId: string,
  cwd: string,
  branchSandbox?: { machineBranchId: string; sandboxId: string },
): MachineNodeHandleSet {
  const self: MachineNodeHandle = {
    kind: branchSandbox ? 'branch' : 'machine',
    machineId,
    cwd,
    ...(branchSandbox ? { branchSandbox } : {}),
  };
  return { self, handles: [self] };
}


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

function okMachines(): MachineDirectoryDeps {
  return {
    listMachines: async () => [{ kind: 'own' }],
    describeMachine: async () => ({ name: 'My Machine' }),
    isMachineAccessible: async () => ({ allowed: true }),
  };
}

function fakeRunDeps(): SandboxRunDeps {
  return {
    isEnabled: () => true,
    acquireSandbox: async () => ({ ok: true, sandboxId: 'sbx', resumed: false }),
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

/**
 * The file tools' cwd policy (issue #2204 follow-up, F9). `bash` has always
 * defaulted to the resolved node's cwd; the file tools rooted every relative
 * path at SANDBOX_ROOT instead, so a targeted read/write hit a different file
 * than a targeted `bash` in the same node.
 */
describe('nodeScopedPath', () => {
  it('given a relative path and a node cwd, should anchor the path to that cwd', () => {
    expect(nodeScopedPath('a.txt', { cwd: '/workspace/projects/foo' })).toBe('/workspace/projects/foo/a.txt');
  });

  it('given a nested relative path, should preserve the remainder under the node cwd', () => {
    expect(nodeScopedPath('src/index.ts', { cwd: '/workspace/repo' })).toBe('/workspace/repo/src/index.ts');
  });

  it('given no node, should return the path untouched — an unbound call keeps the runner\'s SANDBOX_ROOT default', () => {
    expect(nodeScopedPath('a.txt', undefined)).toBe('a.txt');
  });

  it('given an ABSOLUTE path, should leave it alone — the file-tool analogue of bash\'s explicit cwd', () => {
    expect(nodeScopedPath('/workspace/other/a.txt', { cwd: '/workspace/repo' })).toBe('/workspace/other/a.txt');
  });

  it('given a node cwd with a trailing slash, should not emit a doubled separator', () => {
    expect(nodeScopedPath('a.txt', { cwd: '/workspace/repo/' })).toBe('/workspace/repo/a.txt');
  });

  it('given a machine-root node, should be a no-op in effect — /workspace is the runner default anyway', () => {
    expect(nodeScopedPath('a.txt', { cwd: '/workspace' })).toBe('/workspace/a.txt');
  });
});

describe('createSandboxTools', () => {
  it('bash: given a resolvable context, should delegate to the runner and return its result', async () => {
    const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate, machines: okMachines() });
    const result = await exec(tools.bash, { command: 'echo hi' }, {});
    expect(result).toMatchObject({ success: true, stdout: 'hi', exitCode: 0 });
  });

  it('bash: given the resolved active machine is no longer accessible (page view revoked), should deny without acquiring a sandbox', async () => {
    let acquired = false;
    const runDeps = fakeRunDeps();
    runDeps.acquireSandbox = async () => {
      acquired = true;
      return { ok: true, sandboxId: 'sbx', resumed: false };
    };
    // The machine is still CONFIGURED (so resolveActiveMachine would happily
    // resolve it as the default), but the actor's page-view access to that
    // Terminal page has since been revoked.
    const machines: MachineDirectoryDeps = {
      listMachines: async () => [{ kind: 'existing', machineId: 't1' }],
      describeMachine: async () => ({ name: 'Shared Terminal' }),
      isMachineAccessible: async () => ({ allowed: false }),
    };
    const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate, machines });
    const result = await exec(tools.bash, { command: 'echo hi' }, { userId: 'u1' });
    expect(result).toMatchObject({ success: false });
    expect(acquired).toBe(false);
  });

  it('bash: given the access denial carries a reason (e.g. allowPageAgents off), should surface that reason to the model', async () => {
    const machines: MachineDirectoryDeps = {
      listMachines: async () => [{ kind: 'existing', machineId: 't1' }],
      describeMachine: async () => ({ name: 'Locked Machine' }),
      isMachineAccessible: async () => ({
        allowed: false,
        reason: 'The machine "Locked Machine" does not allow page agents.',
      }),
    };
    const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate, machines });
    const result = await exec(tools.bash, { command: 'echo hi' }, { userId: 'u1' });
    expect(result).toEqual({
      success: false,
      error: 'The machine "Locked Machine" does not allow page agents.',
    });
  });

  it('bash: given the default machines[0] is blocked but a later configured machine is usable, should fall back to the usable one instead of dead-ending', async () => {
    const seenAcquisitions: Array<{ activeMachine?: unknown }> = [];
    const runDeps = fakeRunDeps();
    runDeps.acquireSandbox = async (input) => {
      seenAcquisitions.push(input as { activeMachine?: unknown });
      return { ok: true, sandboxId: 'sbx', resumed: false };
    };
    const machines: MachineDirectoryDeps = {
      listMachines: async () => [
        { kind: 'existing', machineId: 'locked-1' },
        { kind: 'existing', machineId: 'open-2' },
      ],
      describeMachine: async () => ({ name: 'Machine' }),
      isMachineAccessible: async (_c, m) =>
        m.kind === 'existing' && m.machineId === 'open-2'
          ? { allowed: true }
          : { allowed: false, reason: 'The machine "Locked Machine" does not allow page agents.' },
    };
    const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate, machines });
    const result = await exec(tools.bash, { command: 'echo hi' }, { userId: 'u1' });
    expect(result).toMatchObject({ success: true });
    expect(seenAcquisitions).toEqual([
      expect.objectContaining({ activeMachine: { kind: 'existing', machineId: 'open-2' } }),
    ]);
  });

  it('bash: given EVERY configured machine is blocked, should surface the FIRST machine\'s specific denial reason (not the misleading "Terminal access is not enabled")', async () => {
    const machines: MachineDirectoryDeps = {
      listMachines: async () => [
        { kind: 'existing', machineId: 'hidden-1' },
        { kind: 'existing', machineId: 'hidden-2' },
      ],
      describeMachine: async () => ({ name: 'Hidden' }),
      isMachineAccessible: async (_c, m) => ({
        allowed: false,
        reason: `The machine "${m.kind === 'existing' ? m.machineId : 'own'}" is not visible to the global assistant.`,
      }),
    };
    const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate, machines });
    const result = await exec(tools.bash, { command: 'echo hi' }, { userId: 'u1' });
    expect(result).toEqual({
      success: false,
      error: 'The machine "hidden-1" is not visible to the global assistant.',
    });
  });

  it('bash: given an explicitly SWITCHED machine becomes blocked, should deny with its reason rather than silently rerouting to another machine', async () => {
    let acquired = false;
    const runDeps = fakeRunDeps();
    runDeps.acquireSandbox = async () => {
      acquired = true;
      return { ok: true, sandboxId: 'sbx', resumed: false };
    };
    const machines: MachineDirectoryDeps = {
      listMachines: async () => [
        { kind: 'existing', machineId: 'open-1' },
        { kind: 'existing', machineId: 'locked-2' },
      ],
      describeMachine: async () => ({ name: 'Machine' }),
      isMachineAccessible: async (_c, m) =>
        m.kind === 'existing' && m.machineId === 'locked-2'
          ? { allowed: false, reason: 'The machine "Locked" does not allow page agents.' }
          : { allowed: true },
    };
    const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate, machines });
    const rawContext: ToolExecutionContext = {
      userId: 'u1',
      activeMachine: { kind: 'existing', machineId: 'locked-2' },
    };
    const result = await exec(tools.bash, { command: 'echo hi' }, rawContext);
    expect(result).toEqual({
      success: false,
      error: 'The machine "Locked" does not allow page agents.',
    });
    expect(acquired).toBe(false);
  });

  it('bash: given no configured machines (machineAccess off), should deny instead of falling back to the own machine', async () => {
    let acquired = false;
    const runDeps = fakeRunDeps();
    runDeps.acquireSandbox = async () => {
      acquired = true;
      return { ok: true, sandboxId: 'sbx', resumed: false };
    };
    // createMachineDirectory.listMachines returns [] exactly when machineAccess
    // is off — this must deny the call, not silently resolve to { kind: 'own' }
    // (which used to key an implicit persistent machine off the agent's own
    // page, bypassing the machineAccess gate entirely).
    const machines: MachineDirectoryDeps = {
      listMachines: async () => [],
      describeMachine: async () => ({ name: 'My Machine' }),
      isMachineAccessible: async () => ({ allowed: true }),
    };
    const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate, machines });
    const result = await exec(tools.bash, { command: 'echo hi' }, { userId: 'u1' });
    expect(result).toMatchObject({ success: false });
    expect(acquired).toBe(false);
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
      machines: okMachines(),
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
      machines: okMachines(),
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
      machines: okMachines(),
    });
    const result = await exec(tools.writeFile, { path: 'a.txt', content: 'x' }, {});
    expect(result).toEqual({ success: false, error: 'disabled' });
    expect(wrote).toBe(false);
  });

  it('writeFile: should delegate and report bytes written', async () => {
    const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate, machines: okMachines() });
    const result = await exec(tools.writeFile, { path: 'a.txt', content: 'hello' }, {});
    expect(result).toMatchObject({ success: true, path: 'a.txt', bytesWritten: 5 });
  });

  it('readFile: should delegate and return file contents', async () => {
    const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate, machines: okMachines() });
    const result = await exec(tools.readFile, { path: 'a.txt' }, {});
    expect(result).toMatchObject({ success: true, path: 'a.txt', content: 'data' });
  });

  it('bash inputSchema: should reject an empty command', () => {
    const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate, machines: okMachines() });
    const schema = tools.bash.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ command: '' }).success).toBe(false);
    expect(schema.safeParse({ command: 'ls' }).success).toBe(true);
  });

  describe('schema strictness', () => {
    function schemaOf(tools: ReturnType<typeof createSandboxTools>, name: keyof ReturnType<typeof createSandboxTools>) {
      return tools[name].inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    }

    it('writeFile inputSchema: given an unrecognized cwd field, should reject instead of silently dropping it', () => {
      const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate, machines: okMachines() });
      const schema = schemaOf(tools, 'writeFile');
      expect(schema.safeParse({ path: 'a.txt', content: 'x', cwd: 'PageSpace' }).success).toBe(false);
      expect(schema.safeParse({ path: 'a.txt', content: 'x' }).success).toBe(true);
    });

    it('readFile inputSchema: given an unrecognized cwd field, should reject instead of silently dropping it', () => {
      const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate, machines: okMachines() });
      const schema = schemaOf(tools, 'readFile');
      expect(schema.safeParse({ path: 'a.txt', cwd: 'PageSpace' }).success).toBe(false);
      expect(schema.safeParse({ path: 'a.txt' }).success).toBe(true);
    });

    it('editFile inputSchema: given an unrecognized cwd field, should reject instead of silently dropping it', () => {
      const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate, machines: okMachines() });
      const schema = schemaOf(tools, 'editFile');
      expect(schema.safeParse({ path: 'a.txt', oldString: 'x', newString: 'y', cwd: 'PageSpace' }).success).toBe(false);
      expect(schema.safeParse({ path: 'a.txt', oldString: 'x', newString: 'y' }).success).toBe(true);
    });

    it('bash inputSchema: given a legitimate extra-looking but unknown field, should reject it', () => {
      const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate, machines: okMachines() });
      const schema = schemaOf(tools, 'bash');
      expect(schema.safeParse({ command: 'ls', bogus: true }).success).toBe(false);
      expect(schema.safeParse({ command: 'ls', cwd: 'PageSpace' }).success).toBe(true);
    });
  });

  it('editFile: should delegate and report replacements', async () => {
    const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate, machines: okMachines() });
    const result = await exec(tools.editFile, { path: 'a.txt', oldString: 'data', newString: 'X' }, {});
    expect(result).toMatchObject({ success: true, path: 'a.txt', replacements: 1 });
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
      machines: okMachines(),
    });
    const result = await exec(tools.editFile, { path: 'a.txt', oldString: 'data', newString: 'X' }, {});
    expect(result).toEqual({ success: false, error: 'disabled' });
    expect(wrote).toBe(false);
  });

  it('editFile inputSchema: should require path/oldString/newString and accept replaceAll', () => {
    const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate, machines: okMachines() });
    const schema = tools.editFile.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ path: 'a', oldString: 'x', newString: 'y' }).success).toBe(true);
    expect(schema.safeParse({ path: 'a', oldString: 'x', newString: 'y', replaceAll: true }).success).toBe(true);
    expect(schema.safeParse({ path: 'a', oldString: 'x' }).success).toBe(false);
  });

  describe('list_machines', () => {
    it('given a single configured machine, should report it as active with no warm-state fields', async () => {
      const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate, machines: okMachines() });
      const result = (await exec(tools.list_machines, {}, {})) as { success: true; machines: unknown[] };
      expect(result.success).toBe(true);
      expect(result.machines).toEqual([{ id: 'own', name: 'My Machine', active: true }]);
      // No running/hibernated/installing/warm-state field of any kind.
      expect(Object.keys(result.machines[0] as object).sort()).toEqual(['active', 'id', 'name']);
    });

    it('given multiple configured machines and no prior switch, should default the active flag to machines[0]', async () => {
      const machines: MachineDirectoryDeps = {
        listMachines: async () => [{ kind: 'own' }, { kind: 'existing', machineId: 't1' }],
        describeMachine: async (_c, m) =>
          m.kind === 'own' ? { name: 'My Machine' } : { name: 'Shared Terminal', description: 'Team box' },
        isMachineAccessible: async () => ({ allowed: true }),
      };
      const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate, machines });
      const result = (await exec(tools.list_machines, {}, {})) as {
        success: true;
        machines: Array<{ id: string; name: string; active: boolean; description?: string }>;
      };
      expect(result.machines).toEqual([
        { id: 'own', name: 'My Machine', active: true },
        { id: 't1', name: 'Shared Terminal', description: 'Team box', active: false },
      ]);
    });

    it('given a rawContext.activeMachine already set to a configured machine, should reflect it as active', async () => {
      const machines: MachineDirectoryDeps = {
        listMachines: async () => [{ kind: 'own' }, { kind: 'existing', machineId: 't1' }],
        describeMachine: async (_c, m) => (m.kind === 'own' ? { name: 'My Machine' } : { name: 'Shared Terminal' }),
        isMachineAccessible: async () => ({ allowed: true }),
      };
      const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate, machines });
      const rawContext: ToolExecutionContext = { userId: 'u1', activeMachine: { kind: 'existing', machineId: 't1' } };
      const result = (await exec(tools.list_machines, {}, rawContext)) as {
        success: true;
        machines: Array<{ id: string; active: boolean }>;
      };
      expect(result.machines.find((m) => m.id === 't1')?.active).toBe(true);
      expect(result.machines.find((m) => m.id === 'own')?.active).toBe(false);
    });

    it('given a configured machine the actor can no longer access, should exclude it instead of exposing its name', async () => {
      const machines: MachineDirectoryDeps = {
        listMachines: async () => [{ kind: 'own' }, { kind: 'existing', machineId: 'revoked' }],
        describeMachine: async (_c, m) => (m.kind === 'own' ? { name: 'My Machine' } : { name: 'Should Not Appear' }),
        isMachineAccessible: async (_c, m) => ({ allowed: m.kind === 'own' }),
      };
      const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate, machines });
      const result = (await exec(tools.list_machines, {}, {})) as { success: true; machines: Array<{ id: string }> };
      expect(result.machines).toEqual([{ id: 'own', name: 'My Machine', active: true }]);
      expect(result.machines.find((m) => m.id === 'revoked')).toBeUndefined();
    });

    it('given machines[0] is blocked, should mark the fallback machine as active — consistent with where bash will actually route', async () => {
      const machines: MachineDirectoryDeps = {
        listMachines: async () => [
          { kind: 'existing', machineId: 'locked-1' },
          { kind: 'existing', machineId: 'open-2' },
        ],
        describeMachine: async () => ({ name: 'Machine' }),
        isMachineAccessible: async (_c, m) =>
          m.kind === 'existing' && m.machineId === 'open-2'
            ? { allowed: true }
            : { allowed: false, reason: 'blocked' },
      };
      const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate, machines });
      const result = (await exec(tools.list_machines, {}, {})) as {
        success: true;
        machines: Array<{ id: string; active: boolean }>;
      };
      expect(result.machines).toEqual([{ id: 'open-2', name: 'Machine', active: true }]);
    });

    it('given N configured machines, should call isMachineAccessible exactly N times — once each, not once for active-selection plus once for the display filter', async () => {
      const isMachineAccessible = vi.fn(async (_c: unknown, m: { kind: string; machineId?: string }) =>
        m.kind === 'existing' && m.machineId === 'open-2' ? { allowed: true } : { allowed: false, reason: 'blocked' },
      );
      const machines: MachineDirectoryDeps = {
        listMachines: async () => [
          { kind: 'existing', machineId: 'locked-1' },
          { kind: 'existing', machineId: 'open-2' },
        ],
        describeMachine: async () => ({ name: 'Machine' }),
        isMachineAccessible,
      };
      const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate, machines });
      await exec(tools.list_machines, {}, {});
      expect(isMachineAccessible).toHaveBeenCalledTimes(2);
    });
  });

  describe('switch_machine', () => {
    it('given a configured and accessible machine, should mutate rawContext.activeMachine and return success', async () => {
      const machines: MachineDirectoryDeps = {
        listMachines: async () => [{ kind: 'own' }, { kind: 'existing', machineId: 't1' }],
        describeMachine: async (_c, m) => (m.kind === 'own' ? { name: 'My Machine' } : { name: 'Shared Terminal' }),
        isMachineAccessible: async () => ({ allowed: true }),
      };
      const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate, machines });
      const rawContext: ToolExecutionContext = { userId: 'u1' };
      const result = await exec(tools.switch_machine, { machine: 't1' }, rawContext);
      expect(result).toEqual({ success: true, active: 't1', name: 'Shared Terminal' });
      expect(rawContext.activeMachine).toEqual({ kind: 'existing', machineId: 't1' });
    });

    it('given the same rawContext reused by a later call in the run, should carry the switched machine forward', async () => {
      const machines: MachineDirectoryDeps = {
        listMachines: async () => [{ kind: 'own' }, { kind: 'existing', machineId: 't1' }],
        describeMachine: async (_c, m) => (m.kind === 'own' ? { name: 'My Machine' } : { name: 'Shared Terminal' }),
        isMachineAccessible: async () => ({ allowed: true }),
      };
      const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate, machines });
      const rawContext: ToolExecutionContext = { userId: 'u1' };
      await exec(tools.switch_machine, { machine: 't1' }, rawContext);
      const listed = (await exec(tools.list_machines, {}, rawContext)) as {
        machines: Array<{ id: string; active: boolean }>;
      };
      expect(listed.machines.find((m) => m.id === 't1')?.active).toBe(true);
    });

    it('given a machine id not in the configured list, should reject as unconfigured', async () => {
      const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate, machines: okMachines() });
      const rawContext: ToolExecutionContext = { userId: 'u1' };
      const result = await exec(tools.switch_machine, { machine: 'not-a-real-machine' }, rawContext);
      expect(result).toMatchObject({ success: false, reason: 'unconfigured' });
      expect(rawContext.activeMachine).toBeUndefined();
    });

    it('given a configured but inaccessible machine, should reject as inaccessible', async () => {
      const machines: MachineDirectoryDeps = {
        listMachines: async () => [{ kind: 'own' }, { kind: 'existing', machineId: 't1' }],
        describeMachine: async () => ({ name: 'Shared Terminal' }),
        isMachineAccessible: async (_c, m) => ({ allowed: m.kind === 'own' }),
      };
      const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate, machines });
      const rawContext: ToolExecutionContext = { userId: 'u1' };
      const result = await exec(tools.switch_machine, { machine: 't1' }, rawContext);
      expect(result).toMatchObject({ success: false, reason: 'inaccessible' });
      expect(rawContext.activeMachine).toBeUndefined();
    });

    it('given the access denial carries a reason, should surface that reason instead of the generic message', async () => {
      const machines: MachineDirectoryDeps = {
        listMachines: async () => [{ kind: 'existing', machineId: 't1' }],
        describeMachine: async () => ({ name: 'Locked Machine' }),
        isMachineAccessible: async () => ({
          allowed: false,
          reason: 'The machine "Locked Machine" does not allow page agents.',
        }),
      };
      const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate, machines });
      const rawContext: ToolExecutionContext = { userId: 'u1' };
      const result = await exec(tools.switch_machine, { machine: 't1' }, rawContext);
      expect(result).toEqual({
        success: false,
        error: 'The machine "Locked Machine" does not allow page agents.',
        reason: 'inaccessible',
      });
      expect(rawContext.activeMachine).toBeUndefined();
    });

    it('given a toggle denial carrying a code, should return that code as the machine-readable reason (not "inaccessible")', async () => {
      const machines: MachineDirectoryDeps = {
        listMachines: async () => [{ kind: 'existing', machineId: 't1' }],
        describeMachine: async () => ({ name: 'Locked Machine' }),
        isMachineAccessible: async () => ({
          allowed: false,
          code: 'page_agents_disabled',
          reason: 'The machine "Locked Machine" does not allow page agents.',
        }),
      };
      const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate, machines });
      const rawContext: ToolExecutionContext = { userId: 'u1' };
      const result = await exec(tools.switch_machine, { machine: 't1' }, rawContext);
      expect(result).toEqual({
        success: false,
        error: 'The machine "Locked Machine" does not allow page agents.',
        reason: 'page_agents_disabled',
      });
      expect(rawContext.activeMachine).toBeUndefined();
    });

    it('given a switch_machine call followed by bash, should route the acquire request to the switched machine', async () => {
      const machines: MachineDirectoryDeps = {
        listMachines: async () => [{ kind: 'own' }, { kind: 'existing', machineId: 't1' }],
        describeMachine: async (_c, m) => (m.kind === 'own' ? { name: 'My Machine' } : { name: 'Shared Terminal' }),
        isMachineAccessible: async () => ({ allowed: true }),
      };
      const seenAcquisitions: unknown[] = [];
      const runDeps = fakeRunDeps();
      runDeps.acquireSandbox = async (input) => {
        seenAcquisitions.push(input);
        return { ok: true, sandboxId: 'sbx', resumed: false };
      };
      const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate, machines });
      const rawContext: ToolExecutionContext = { userId: 'u1' };

      await exec(tools.switch_machine, { machine: 't1' }, rawContext);
      await exec(tools.bash, { command: 'echo hi' }, rawContext);

      expect(seenAcquisitions).toEqual([
        expect.objectContaining({ activeMachine: { kind: 'existing', machineId: 't1' } }),
      ]);
    });

    it('inputSchema: should reject an empty machine id', () => {
      const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate, machines: okMachines() });
      const schema = tools.switch_machine.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
      expect(schema.safeParse({ machine: '' }).success).toBe(false);
      expect(schema.safeParse({ machine: 'own' }).success).toBe(true);
      expect(schema.safeParse({ machine: 'own', bogus: true }).success).toBe(false);
    });

    it('given no rawContext to persist the switch onto, should return an error instead of a silent no-op success', async () => {
      // A permissive resolveContext (unlike production's, which fails closed
      // without a conversationId/userId) can still resolve successfully even
      // when no experimental_context was passed at all.
      const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate, machines: okMachines() });
      const result = await exec(tools.switch_machine, { machine: 'own' }, undefined);
      expect(result).toEqual({
        success: false,
        error: 'Unable to switch machines without an execution context.',
      });
    });
  });

  describe('resolveDriveId override', () => {
    it('given machines has no resolveDriveId, should use the ambient ctx.driveId unchanged', async () => {
      const seenAcquisitions: unknown[] = [];
      const runDeps = fakeRunDeps();
      runDeps.acquireSandbox = async (input) => {
        seenAcquisitions.push(input);
        return { ok: true, sandboxId: 'sbx', resumed: false };
      };
      const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate, machines: okMachines() });
      await exec(tools.bash, { command: 'echo hi' }, {});
      expect(seenAcquisitions).toEqual([expect.objectContaining({ driveId: 'd1' })]);
    });

    it('given machines provides resolveDriveId, should override the ambient ctx.driveId with its result', async () => {
      const seenAcquisitions: unknown[] = [];
      const runDeps = fakeRunDeps();
      runDeps.acquireSandbox = async (input) => {
        seenAcquisitions.push(input);
        return { ok: true, sandboxId: 'sbx', resumed: false };
      };
      const machines: MachineDirectoryDeps = {
        listMachines: async () => [{ kind: 'existing', machineId: 't1' }],
        describeMachine: async () => ({ name: 'Shared Terminal' }),
        isMachineAccessible: async () => ({ allowed: true }),
        resolveDriveId: async () => 'home-drive-1',
      };
      const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate, machines });
      await exec(tools.bash, { command: 'echo hi' }, {});
      expect(seenAcquisitions).toEqual([expect.objectContaining({ driveId: 'home-drive-1' })]);
    });

    it('given machines has no resolveTenantId, should use the ambient ctx.tenantId unchanged', async () => {
      const seenAcquisitions: unknown[] = [];
      const runDeps = fakeRunDeps();
      runDeps.acquireSandbox = async (input) => {
        seenAcquisitions.push(input);
        return { ok: true, sandboxId: 'sbx', resumed: false };
      };
      const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate, machines: okMachines() });
      await exec(tools.bash, { command: 'echo hi' }, {});
      expect(seenAcquisitions).toEqual([expect.objectContaining({ tenantId: 't1' })]);
    });

    it('given machines provides resolveTenantId, should override the ambient ctx.tenantId with its result — keeping it consistent with the machine\'s own resolved driveId', async () => {
      const seenAcquisitions: unknown[] = [];
      const runDeps = fakeRunDeps();
      runDeps.acquireSandbox = async (input) => {
        seenAcquisitions.push(input);
        return { ok: true, sandboxId: 'sbx', resumed: false };
      };
      const machines: MachineDirectoryDeps = {
        listMachines: async () => [{ kind: 'existing', machineId: 't1' }],
        describeMachine: async () => ({ name: 'Shared Terminal' }),
        isMachineAccessible: async () => ({ allowed: true }),
        resolveDriveId: async () => 'home-drive-1',
        resolveTenantId: async () => 'real-drive-owner',
      };
      const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate, machines });
      await exec(tools.bash, { command: 'echo hi' }, {});
      expect(seenAcquisitions).toEqual([
        expect.objectContaining({ driveId: 'home-drive-1', tenantId: 'real-drive-owner' }),
      ]);
    });
  });

  describe('machine-pane binding (machineBinding)', () => {
    function runDepsCapturingCwd() {
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
      return { runDeps, seenCwds };
    }

    it('bash: given a binding and no explicit cwd, should default the runner cwd to the binding\'s cwd', async () => {
      const { runDeps, seenCwds } = runDepsCapturingCwd();
      const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate, machines: okMachines() });
      const rawContext: ToolExecutionContext = {
        userId: 'u1',
        machineBinding: boundTo('m1', '/workspace/repo'),
      };
      const result = await exec(tools.bash, { command: 'echo hi' }, rawContext);
      expect(result).toMatchObject({ success: true });
      expect(seenCwds).toEqual(['/workspace/repo']);
    });

    it('bash: given a binding AND an explicit cwd, the explicit cwd should win', async () => {
      const { runDeps, seenCwds } = runDepsCapturingCwd();
      const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate, machines: okMachines() });
      const rawContext: ToolExecutionContext = {
        userId: 'u1',
        machineBinding: boundTo('m1', '/workspace/repo'),
      };
      const result = await exec(tools.bash, { command: 'echo hi', cwd: '/workspace/other' }, rawContext);
      expect(result).toMatchObject({ success: true });
      expect(seenCwds).toEqual(['/workspace/other']);
    });

    it('bash: given no binding, should leave the default cwd behavior unchanged (the runner\'s own SANDBOX_ROOT default)', async () => {
      const { runDeps, seenCwds } = runDepsCapturingCwd();
      const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate, machines: okMachines() });
      const result = await exec(tools.bash, { command: 'echo hi' }, { userId: 'u1' });
      expect(result).toMatchObject({ success: true });
      expect(seenCwds).toEqual(['/workspace']);
    });

    it('bash: given a binding with a branchSandbox, acquireSandbox should carry the branch target', async () => {
      const seenAcquisitions: unknown[] = [];
      const runDeps = fakeRunDeps();
      runDeps.acquireSandbox = async (input) => {
        seenAcquisitions.push(input);
        return { ok: true, sandboxId: 'sbx', resumed: false };
      };
      const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate, machines: okMachines() });
      const rawContext: ToolExecutionContext = {
        userId: 'u1',
        machineBinding: boundTo('m1', '/workspace/repo', { machineBranchId: 'branch-1', sandboxId: 'sbx-1' }),
      };
      const result = await exec(tools.bash, { command: 'echo hi' }, rawContext);
      expect(result).toMatchObject({ success: true });
      expect(seenAcquisitions).toEqual([
        expect.objectContaining({ branchSandbox: { machineId: 'm1', machineBranchId: 'branch-1' } }),
      ]);
    });

    it('bash: given no binding, acquireSandbox should carry no branchSandbox', async () => {
      const seenAcquisitions: unknown[] = [];
      const runDeps = fakeRunDeps();
      runDeps.acquireSandbox = async (input) => {
        seenAcquisitions.push(input);
        return { ok: true, sandboxId: 'sbx', resumed: false };
      };
      const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate, machines: okMachines() });
      await exec(tools.bash, { command: 'echo hi' }, { userId: 'u1' });
      expect(seenAcquisitions).toEqual([expect.objectContaining({ branchSandbox: undefined })]);
    });

    it('bash: given the branch acquire fails, should surface a tool error and run no command', async () => {
      let reconnected = false;
      const runDeps = fakeRunDeps();
      runDeps.acquireSandbox = async () => ({ ok: false, reason: 'branch_not_found' });
      runDeps.reconnect = async () => {
        reconnected = true;
        return {
          sandboxId: 'sbx',
          spriteInstanceId: null,
          runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
          writeFiles: async () => {},
          readFileToBuffer: async () => Buffer.from(''),
          createCheckpoint: async () => {},
        };
      };
      const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate, machines: okMachines() });
      const rawContext: ToolExecutionContext = {
        userId: 'u1',
        machineBinding: boundTo('m1', '/workspace/repo', { machineBranchId: 'branch-1', sandboxId: 'sbx-1' }),
      };
      const result = await exec(tools.bash, { command: 'echo hi' }, rawContext);
      expect(result).toMatchObject({ success: false });
      expect(reconnected).toBe(false);
    });
  });

  /**
   * Direct child addressing: a bound conversation may aim any file tool at a
   * node BENEATH it via `target`, resolved against the derived handle set. A
   * node outside the set is not addressable — the set is the policy.
   */
  describe('target addressing (cascade)', () => {
    const MACHINE: MachineNodeHandle = { kind: 'machine', machineId: 'm1', cwd: '/workspace' };
    const PROJECT: MachineNodeHandle = {
      kind: 'project',
      machineId: 'm1',
      project: 'repo',
      cwd: '/workspace/projects/repo',
    };
    const BRANCH: MachineNodeHandle = {
      kind: 'branch',
      machineId: 'm1',
      project: 'repo',
      branch: 'feature',
      cwd: '/workspace/repo',
      branchSandbox: { machineBranchId: 'branch-1', sandboxId: 'sbx-1' },
    };
    const machineRootBinding: MachineNodeHandleSet = { self: MACHINE, handles: [MACHINE, PROJECT, BRANCH] };

    function capturingRunDeps() {
      const seenCwds: Array<string | undefined> = [];
      const seenAcquisitions: Array<{ branchSandbox?: unknown }> = [];
      // Where the file tools actually landed — the runner resolves the path it
      // is handed against SANDBOX_ROOT, so this is the end of the path story.
      const seenWritePaths: string[] = [];
      const seenReadPaths: string[] = [];
      const runDeps = fakeRunDeps();
      runDeps.acquireSandbox = async (input) => {
        seenAcquisitions.push(input);
        return { ok: true, sandboxId: 'sbx', resumed: false };
      };
      runDeps.reconnect = async () => ({
        sandboxId: 'sbx',
        spriteInstanceId: null,
        runCommand: async (args: { cwd?: string }) => {
          seenCwds.push(args.cwd);
          return { exitCode: 0, stdout: 'hi', stderr: '' };
        },
        writeFiles: async (files: Array<{ path: string }>) => {
          for (const file of files) seenWritePaths.push(file.path);
        },
        readFileToBuffer: async (args: { path: string }) => {
          seenReadPaths.push(args.path);
          return Buffer.from('data');
        },
        createCheckpoint: async () => {},
      });
      return { runDeps, seenCwds, seenAcquisitions, seenWritePaths, seenReadPaths };
    }

    it('bash: given target { project }, should run at the project\'s cwd on the MACHINE\'s own Sprite', async () => {
      const { runDeps, seenCwds, seenAcquisitions } = capturingRunDeps();
      const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate, machines: okMachines() });
      const result = await exec(
        tools.bash,
        { command: 'echo hi', target: { project: 'repo' } },
        { userId: 'u1', machineBinding: machineRootBinding },
      );
      expect(result).toMatchObject({ success: true });
      expect(seenCwds).toEqual(['/workspace/projects/repo']);
      expect(seenAcquisitions).toEqual([expect.objectContaining({ branchSandbox: undefined })]);
    });

    it('bash: given target { branch }, should route to the branch Sprite at the branch cwd — matching a natively-bound branch conversation', async () => {
      const { runDeps, seenCwds, seenAcquisitions } = capturingRunDeps();
      const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate, machines: okMachines() });
      const result = await exec(
        tools.bash,
        { command: 'echo hi', target: { project: 'repo', branch: 'feature' } },
        { userId: 'u1', machineBinding: machineRootBinding },
      );
      expect(result).toMatchObject({ success: true });
      expect(seenCwds).toEqual(['/workspace/repo']);
      expect(seenAcquisitions).toEqual([
        expect.objectContaining({ branchSandbox: { machineId: 'm1', machineBranchId: 'branch-1' } }),
      ]);
    });

    it('bash: given an explicit cwd alongside a target, the explicit cwd should still win', async () => {
      const { runDeps, seenCwds } = capturingRunDeps();
      const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate, machines: okMachines() });
      await exec(
        tools.bash,
        { command: 'echo hi', cwd: '/workspace/other', target: { project: 'repo' } },
        { userId: 'u1', machineBinding: machineRootBinding },
      );
      expect(seenCwds).toEqual(['/workspace/other']);
    });

    it('bash: given a target outside the derived set, should deny without acquiring a sandbox', async () => {
      const { runDeps, seenAcquisitions } = capturingRunDeps();
      const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate, machines: okMachines() });
      const branchBinding: MachineNodeHandleSet = { self: BRANCH, handles: [BRANCH] };
      const result = await exec(
        tools.bash,
        { command: 'echo hi', target: { project: 'sibling' } },
        { userId: 'u1', machineBinding: branchBinding },
      );
      expect(result).toMatchObject({ success: false });
      expect(seenAcquisitions).toEqual([]);
    });

    it('bash: given a target on an UNBOUND conversation, should deny — targets only exist inside a bound node scope', async () => {
      const { runDeps, seenAcquisitions } = capturingRunDeps();
      const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate, machines: okMachines() });
      const result = await exec(tools.bash, { command: 'echo hi', target: { project: 'repo' } }, { userId: 'u1' });
      expect(result).toMatchObject({ success: false });
      expect(seenAcquisitions).toEqual([]);
    });

    it('writeFile/readFile/editFile: given target { branch }, should each route to the branch Sprite', async () => {
      const { runDeps, seenAcquisitions } = capturingRunDeps();
      const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate, machines: okMachines() });
      const context = { userId: 'u1', machineBinding: machineRootBinding };
      const target = { project: 'repo', branch: 'feature' };
      await exec(tools.writeFile, { path: 'a.txt', content: 'x', target }, context);
      await exec(tools.readFile, { path: 'a.txt', target }, context);
      await exec(tools.editFile, { path: 'a.txt', oldString: 'data', newString: 'X', target }, context);
      expect(seenAcquisitions).toEqual([
        expect.objectContaining({ branchSandbox: { machineId: 'm1', machineBranchId: 'branch-1' } }),
        expect.objectContaining({ branchSandbox: { machineId: 'm1', machineBranchId: 'branch-1' } }),
        expect.objectContaining({ branchSandbox: { machineId: 'm1', machineBranchId: 'branch-1' } }),
      ]);
    });

    it('writeFile: given target { project }, should write UNDER the project cwd, not at the sandbox root', async () => {
      const { runDeps, seenWritePaths } = capturingRunDeps();
      const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate, machines: okMachines() });
      await exec(
        tools.writeFile,
        { path: 'a.txt', content: 'x', target: { project: 'repo' } },
        { userId: 'u1', machineBinding: machineRootBinding },
      );
      expect(seenWritePaths).toEqual(['/workspace/projects/repo/a.txt']);
    });

    it('readFile: given target { branch }, should read UNDER the branch cwd — the same file bash would see', async () => {
      const { runDeps, seenReadPaths } = capturingRunDeps();
      const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate, machines: okMachines() });
      await exec(
        tools.readFile,
        { path: 'a.txt', target: { project: 'repo', branch: 'feature' } },
        { userId: 'u1', machineBinding: machineRootBinding },
      );
      expect(seenReadPaths).toEqual(['/workspace/repo/a.txt']);
    });

    it('editFile: given target { project }, should edit the file under the project cwd', async () => {
      const { runDeps, seenReadPaths, seenWritePaths } = capturingRunDeps();
      const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate, machines: okMachines() });
      await exec(
        tools.editFile,
        { path: 'a.txt', oldString: 'data', newString: 'X', target: { project: 'repo' } },
        { userId: 'u1', machineBinding: machineRootBinding },
      );
      expect(seenReadPaths).toEqual(['/workspace/projects/repo/a.txt']);
      expect(seenWritePaths).toEqual(['/workspace/projects/repo/a.txt']);
    });

    it('bash: given a branch-targeted run, the billing/guardrail key should stay the owning machine page id', async () => {
      const { runDeps, seenAcquisitions } = capturingRunDeps();
      const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate, machines: okMachines() });
      await exec(
        tools.bash,
        { command: 'echo hi', target: { project: 'repo', branch: 'feature' } },
        { userId: 'u1', machineBinding: machineRootBinding },
      );
      expect(seenAcquisitions[0]).toMatchObject({ branchSandbox: { machineId: 'm1' } });
    });

    it('bash: given no target, should run at the bound node exactly as before', async () => {
      const { runDeps, seenCwds, seenAcquisitions } = capturingRunDeps();
      const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate, machines: okMachines() });
      await exec(tools.bash, { command: 'echo hi' }, { userId: 'u1', machineBinding: machineRootBinding });
      expect(seenCwds).toEqual(['/workspace']);
      expect(seenAcquisitions).toEqual([expect.objectContaining({ branchSandbox: undefined })]);
    });
  });

  describe('terminal tools resolve the active machine before delegating', () => {
    it('bash/writeFile/readFile/editFile should each resolve the configured machines to determine the active one', async () => {
      const listMachines = vi.fn().mockResolvedValue([{ kind: 'own' }]);
      const machines: MachineDirectoryDeps = {
        listMachines,
        describeMachine: async () => ({ name: 'My Machine' }),
        isMachineAccessible: async () => ({ allowed: true }),
      };
      const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate, machines });
      await exec(tools.bash, { command: 'echo hi' }, {});
      await exec(tools.writeFile, { path: 'a.txt', content: 'x' }, {});
      await exec(tools.readFile, { path: 'a.txt' }, {});
      await exec(tools.editFile, { path: 'a.txt', oldString: 'data', newString: 'X' }, {});
      expect(listMachines).toHaveBeenCalledTimes(4);
    });
  });
});
