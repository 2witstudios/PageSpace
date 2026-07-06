import { describe, it, expect, vi } from 'vitest';

// The factory is provider-agnostic and imports no DB or backing-provider SDK, so
// it is exercised directly with injected fakes (the production wiring + the Fly
// Sprites driver live in sandbox-tools-runtime.ts).
import { createSandboxTools, type MachineDirectoryDeps, type ResolveSandboxContext, type SandboxGate } from '../sandbox-tools';
import type { SandboxRunDeps, SandboxActorContext } from '@pagespace/lib/services/sandbox/tool-runners';
import type { ToolExecutionContext } from '../../core/types';

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
    isMachineAccessible: async () => true,
  };
}

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
      listMachines: async () => [{ kind: 'existing', terminalId: 't1' }],
      describeMachine: async () => ({ name: 'Shared Terminal' }),
      isMachineAccessible: async () => false,
    };
    const tools = createSandboxTools({ runDeps, resolveContext: okResolve, gate: okGate, machines });
    const result = await exec(tools.bash, { command: 'echo hi' }, { userId: 'u1' });
    expect(result).toMatchObject({ success: false });
    expect(acquired).toBe(false);
  });

  it('bash: given no configured machines (terminalAccess off), should deny instead of falling back to the own machine', async () => {
    let acquired = false;
    const runDeps = fakeRunDeps();
    runDeps.acquireSandbox = async () => {
      acquired = true;
      return { ok: true, sandboxId: 'sbx', resumed: false };
    };
    // createMachineDirectory.listMachines returns [] exactly when terminalAccess
    // is off — this must deny the call, not silently resolve to { kind: 'own' }
    // (which used to key an implicit persistent machine off the agent's own
    // page, bypassing the terminalAccess gate entirely).
    const machines: MachineDirectoryDeps = {
      listMachines: async () => [],
      describeMachine: async () => ({ name: 'My Machine' }),
      isMachineAccessible: async () => true,
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
        listMachines: async () => [{ kind: 'own' }, { kind: 'existing', terminalId: 't1' }],
        describeMachine: async (_c, m) =>
          m.kind === 'own' ? { name: 'My Machine' } : { name: 'Shared Terminal', description: 'Team box' },
        isMachineAccessible: async () => true,
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
        listMachines: async () => [{ kind: 'own' }, { kind: 'existing', terminalId: 't1' }],
        describeMachine: async (_c, m) => (m.kind === 'own' ? { name: 'My Machine' } : { name: 'Shared Terminal' }),
        isMachineAccessible: async () => true,
      };
      const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate, machines });
      const rawContext: ToolExecutionContext = { userId: 'u1', activeMachine: { kind: 'existing', terminalId: 't1' } };
      const result = (await exec(tools.list_machines, {}, rawContext)) as {
        success: true;
        machines: Array<{ id: string; active: boolean }>;
      };
      expect(result.machines.find((m) => m.id === 't1')?.active).toBe(true);
      expect(result.machines.find((m) => m.id === 'own')?.active).toBe(false);
    });

    it('given a configured machine the actor can no longer access, should exclude it instead of exposing its name', async () => {
      const machines: MachineDirectoryDeps = {
        listMachines: async () => [{ kind: 'own' }, { kind: 'existing', terminalId: 'revoked' }],
        describeMachine: async (_c, m) => (m.kind === 'own' ? { name: 'My Machine' } : { name: 'Should Not Appear' }),
        isMachineAccessible: async (_c, m) => m.kind === 'own',
      };
      const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate, machines });
      const result = (await exec(tools.list_machines, {}, {})) as { success: true; machines: Array<{ id: string }> };
      expect(result.machines).toEqual([{ id: 'own', name: 'My Machine', active: true }]);
      expect(result.machines.find((m) => m.id === 'revoked')).toBeUndefined();
    });
  });

  describe('switch_machine', () => {
    it('given a configured and accessible machine, should mutate rawContext.activeMachine and return success', async () => {
      const machines: MachineDirectoryDeps = {
        listMachines: async () => [{ kind: 'own' }, { kind: 'existing', terminalId: 't1' }],
        describeMachine: async (_c, m) => (m.kind === 'own' ? { name: 'My Machine' } : { name: 'Shared Terminal' }),
        isMachineAccessible: async () => true,
      };
      const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate, machines });
      const rawContext: ToolExecutionContext = { userId: 'u1' };
      const result = await exec(tools.switch_machine, { machine: 't1' }, rawContext);
      expect(result).toEqual({ success: true, active: 't1', name: 'Shared Terminal' });
      expect(rawContext.activeMachine).toEqual({ kind: 'existing', terminalId: 't1' });
    });

    it('given the same rawContext reused by a later call in the run, should carry the switched machine forward', async () => {
      const machines: MachineDirectoryDeps = {
        listMachines: async () => [{ kind: 'own' }, { kind: 'existing', terminalId: 't1' }],
        describeMachine: async (_c, m) => (m.kind === 'own' ? { name: 'My Machine' } : { name: 'Shared Terminal' }),
        isMachineAccessible: async () => true,
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
        listMachines: async () => [{ kind: 'own' }, { kind: 'existing', terminalId: 't1' }],
        describeMachine: async () => ({ name: 'Shared Terminal' }),
        isMachineAccessible: async (_c, m) => m.kind === 'own',
      };
      const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate, machines });
      const rawContext: ToolExecutionContext = { userId: 'u1' };
      const result = await exec(tools.switch_machine, { machine: 't1' }, rawContext);
      expect(result).toMatchObject({ success: false, reason: 'inaccessible' });
      expect(rawContext.activeMachine).toBeUndefined();
    });

    it('given a switch_machine call followed by bash, should route the acquire request to the switched machine', async () => {
      const machines: MachineDirectoryDeps = {
        listMachines: async () => [{ kind: 'own' }, { kind: 'existing', terminalId: 't1' }],
        describeMachine: async (_c, m) => (m.kind === 'own' ? { name: 'My Machine' } : { name: 'Shared Terminal' }),
        isMachineAccessible: async () => true,
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
        expect.objectContaining({ activeMachine: { kind: 'existing', terminalId: 't1' } }),
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
        listMachines: async () => [{ kind: 'existing', terminalId: 't1' }],
        describeMachine: async () => ({ name: 'Shared Terminal' }),
        isMachineAccessible: async () => true,
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
        listMachines: async () => [{ kind: 'existing', terminalId: 't1' }],
        describeMachine: async () => ({ name: 'Shared Terminal' }),
        isMachineAccessible: async () => true,
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

  describe('terminal tools resolve the active machine before delegating', () => {
    it('bash/writeFile/readFile/editFile should each resolve the configured machines to determine the active one', async () => {
      const listMachines = vi.fn().mockResolvedValue([{ kind: 'own' }]);
      const machines: MachineDirectoryDeps = {
        listMachines,
        describeMachine: async () => ({ name: 'My Machine' }),
        isMachineAccessible: async () => true,
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
