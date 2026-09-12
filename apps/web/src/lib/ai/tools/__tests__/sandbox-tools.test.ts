import { describe, it, expect } from 'vitest';

// The factory is provider-agnostic and imports no DB or backing-provider SDK, so
// it is exercised directly with injected fakes (the production wiring + the Fly
// Sprites driver live in sandbox-tools-runtime.ts). The factory is schema +
// context resolution + gate + environment resolution + delegation, and nothing
// else: every access decision it makes is a pure function's, and the rows it
// lists are already filtered by the store.
import { createSandboxTools, type ResolveEnvironmentTarget, type ResolveSandboxContext, type SandboxGate } from '../sandbox-tools';
import type { SandboxRunDeps, SandboxActorContext } from '@pagespace/lib/services/sandbox/tool-runners';
import { ENV_UNREACHABLE_MESSAGE } from '@pagespace/lib/env-bridge/decide-env-reach';

const ctx: SandboxActorContext = {
  userId: 'u1',
  tenantId: 't1',
  driveId: 'd1',
  conversationId: 'a78aoz3je2ycbofz79zgez9q',
  actorEmail: 'u1@example.com',
  tier: 'pro',
};

const okResolve: ResolveSandboxContext = async () => ctx;
const okGate: SandboxGate = async () => ({ ok: true });

function fakeRunDeps(): SandboxRunDeps {
  return {
    isEnabled: () => true,
    acquireSandbox: async () => ({ ok: true, sandboxId: 'sbx', resumed: false, workspaceId: 'ws-1' }),
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

/** The conversation's own id — the address of its own sandbox, exactly as `list_environments` reports it. */
const CONVERSATION_ID = 'a78aoz3je2ycbofz79zgez9q';

/** A well-SHAPED id that is not this conversation's — what a guess looks like when it happens to parse. */
const OTHER_ID = 'dw9jthqyaza6ga3b6m5nmpqw';

/** The default resolver: the conversation's own sandbox, resolved from the server's record. */
const ownSandbox: ResolveEnvironmentTarget = async ({ environmentId }) => ({
  ok: true,
  target: { id: environmentId, kind: 'conversation', label: "This conversation's own sandbox", driveId: 'd1' },
});

/** No persistent environments reachable — the default for every case that is not about discovery. */
const noEnvironments = async () => [];

function exec(tool: { execute?: unknown }, args: unknown, context: unknown) {
  const fn = tool.execute as (a: unknown, o: unknown) => Promise<unknown>;
  return fn(args, { experimental_context: context });
}

describe('createSandboxTools', () => {
  it('bash: given a resolvable context, should delegate to the runner and return its result', async () => {
    const tools = createSandboxTools({ resolveEnvironment: ownSandbox, listEnvironments: noEnvironments, runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate });
    const result = await exec(tools.bash, { environmentId: CONVERSATION_ID, command: 'echo hi' }, {});
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
    const tools = createSandboxTools({ resolveEnvironment: ownSandbox, listEnvironments: noEnvironments, runDeps, resolveContext: okResolve, gate: okGate });
    const result = await exec(tools.bash, { environmentId: CONVERSATION_ID, command: 'echo hi', cwd: '/workspace/repo', timeoutMs: 5000 }, {});
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
    const tools = createSandboxTools({ resolveEnvironment: ownSandbox, listEnvironments: noEnvironments, runDeps, resolveContext: okResolve, gate: okGate });
    const result = await exec(tools.bash, { environmentId: CONVERSATION_ID, command: 'echo hi' }, { userId: 'u1' });
    expect(result).toMatchObject({ success: true });
    expect(seenCwds).toEqual(['/workspace']);
  });

  it('bash: given an unresolvable context, should surface the resolver error without running', async () => {
    let acquired = false;
    const runDeps = fakeRunDeps();
    runDeps.acquireSandbox = async () => {
      acquired = true;
      return { ok: true, sandboxId: 'sbx', resumed: false, workspaceId: 'ws-1' };
    };
    const tools = createSandboxTools({ resolveEnvironment: ownSandbox, listEnvironments: noEnvironments, runDeps,
      resolveContext: async () => ({ error: 'no drive' }),
      gate: okGate,
    });
    const result = await exec(tools.bash, { environmentId: CONVERSATION_ID, command: 'echo hi' }, {});
    expect(result).toEqual({ success: false, error: 'no drive' });
    expect(acquired).toBe(false);
  });

  it('bash: given the gate denies, should surface the gate error (with retryAfter) without provisioning', async () => {
    let acquired = false;
    const runDeps = fakeRunDeps();
    runDeps.acquireSandbox = async () => {
      acquired = true;
      return { ok: true, sandboxId: 'sbx', resumed: false, workspaceId: 'ws-1' };
    };
    const tools = createSandboxTools({ resolveEnvironment: ownSandbox, listEnvironments: noEnvironments, runDeps,
      resolveContext: okResolve,
      gate: async () => ({ ok: false, reason: 'concurrency_limit', error: 'too many runs', retryAfter: 30 }),
    });
    const result = await exec(tools.bash, { environmentId: CONVERSATION_ID, command: 'echo hi' }, {});
    expect(result).toEqual({ success: false, error: 'too many runs', retryAfter: 30 });
    expect(acquired).toBe(false);
  });

  it('bash: given the gate denies without a retry hint, should not fabricate a retryAfter field', async () => {
    const tools = createSandboxTools({ resolveEnvironment: ownSandbox, listEnvironments: noEnvironments, runDeps: fakeRunDeps(),
      resolveContext: okResolve,
      gate: async () => ({ ok: false, reason: 'kill_switch_off', error: 'disabled' }),
    });
    const result = await exec(tools.bash, { environmentId: CONVERSATION_ID, command: 'echo hi' }, {});
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
    const tools = createSandboxTools({ resolveEnvironment: ownSandbox, listEnvironments: noEnvironments, runDeps,
      resolveContext: okResolve,
      gate: async () => ({ ok: false, reason: 'kill_switch_off', error: 'disabled' }),
    });
    const result = await exec(tools.writeFile, { environmentId: CONVERSATION_ID, path: 'a.txt', content: 'x' }, {});
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
    const tools = createSandboxTools({ resolveEnvironment: ownSandbox, listEnvironments: noEnvironments, runDeps, resolveContext: okResolve, gate: okGate });
    const result = await exec(tools.writeFile, { environmentId: CONVERSATION_ID, path: 'a.txt', content: 'hello' }, {});
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
    const tools = createSandboxTools({ resolveEnvironment: ownSandbox, listEnvironments: noEnvironments, runDeps, resolveContext: okResolve, gate: okGate });
    const result = await exec(tools.readFile, { environmentId: CONVERSATION_ID, path: 'a.txt' }, {});
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
    const tools = createSandboxTools({ resolveEnvironment: ownSandbox, listEnvironments: noEnvironments, runDeps,
      resolveContext: okResolve,
      gate: async () => ({ ok: false, reason: 'kill_switch_off', error: 'disabled' }),
    });
    const result = await exec(tools.readFile, { environmentId: CONVERSATION_ID, path: 'a.txt' }, {});
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
    const tools = createSandboxTools({ resolveEnvironment: ownSandbox, listEnvironments: noEnvironments, runDeps, resolveContext: okResolve, gate: okGate });
    const result = await exec(tools.editFile, { environmentId: CONVERSATION_ID, path: 'a.txt', oldString: 'data', newString: 'X' }, {});
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
    const tools = createSandboxTools({ resolveEnvironment: ownSandbox, listEnvironments: noEnvironments, runDeps, resolveContext: okResolve, gate: okGate });
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
    const tools = createSandboxTools({ resolveEnvironment: ownSandbox, listEnvironments: noEnvironments, runDeps,
      resolveContext: okResolve,
      gate: async () => ({ ok: false, reason: 'kill_switch_off', error: 'disabled' }),
    });
    const result = await exec(tools.editFile, { environmentId: CONVERSATION_ID, path: 'a.txt', oldString: 'data', newString: 'X' }, {});
    expect(result).toEqual({ success: false, error: 'disabled' });
    expect(wrote).toBe(false);
  });

  it('bash inputSchema: should reject an empty command', () => {
    const tools = createSandboxTools({ resolveEnvironment: ownSandbox, listEnvironments: noEnvironments, runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate });
    const schema = tools.bash.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ environmentId: CONVERSATION_ID, command: '' }).success).toBe(false);
    expect(schema.safeParse({ environmentId: CONVERSATION_ID, command: 'ls' }).success).toBe(true);
  });

  it('bash inputSchema: should accept cwd and a positive integer timeoutMs, rejecting invalid ones', () => {
    const tools = createSandboxTools({ resolveEnvironment: ownSandbox, listEnvironments: noEnvironments, runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate });
    const schema = tools.bash.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ environmentId: CONVERSATION_ID, command: 'ls', cwd: '/workspace/repo' }).success).toBe(true);
    expect(schema.safeParse({ environmentId: CONVERSATION_ID, command: 'ls', timeoutMs: 5000 }).success).toBe(true);
    expect(schema.safeParse({ environmentId: CONVERSATION_ID, command: 'ls', timeoutMs: 0 }).success).toBe(false);
    expect(schema.safeParse({ environmentId: CONVERSATION_ID, command: 'ls', timeoutMs: 1.5 }).success).toBe(false);
  });

  describe('schema strictness', () => {
    function schemaOf(tools: ReturnType<typeof createSandboxTools>, name: keyof ReturnType<typeof createSandboxTools>) {
      return tools[name].inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    }

    it('writeFile inputSchema: given an unrecognized field, should reject instead of silently dropping it', () => {
      const tools = createSandboxTools({ resolveEnvironment: ownSandbox, listEnvironments: noEnvironments, runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate });
      const schema = schemaOf(tools, 'writeFile');
      expect(schema.safeParse({ environmentId: CONVERSATION_ID, path: 'a.txt', content: 'x', cwd: 'PageSpace' }).success).toBe(false);
      expect(schema.safeParse({ environmentId: CONVERSATION_ID, path: 'a.txt', content: 'x' }).success).toBe(true);
    });

    it('readFile inputSchema: given an unrecognized field, should reject instead of silently dropping it', () => {
      const tools = createSandboxTools({ resolveEnvironment: ownSandbox, listEnvironments: noEnvironments, runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate });
      const schema = schemaOf(tools, 'readFile');
      expect(schema.safeParse({ environmentId: CONVERSATION_ID, path: 'a.txt', cwd: 'PageSpace' }).success).toBe(false);
      expect(schema.safeParse({ environmentId: CONVERSATION_ID, path: 'a.txt' }).success).toBe(true);
    });

    it('readFile inputSchema: accepts offset 0 and negative — selectLineWindow clamps them to 1', () => {
      // The runner clamps a 0-or-negative offset to line 1 (selectLineWindow),
      // so a schema that refuses those values gives a model a zod error instead
      // of the documented clamp behaviour.
      const tools = createSandboxTools({ resolveEnvironment: ownSandbox, listEnvironments: noEnvironments, runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate });
      const schema = schemaOf(tools, 'readFile');
      expect(schema.safeParse({ environmentId: CONVERSATION_ID, path: 'a.txt', offset: 0 }).success).toBe(true);
      expect(schema.safeParse({ environmentId: CONVERSATION_ID, path: 'a.txt', offset: -5 }).success).toBe(true);
      expect(schema.safeParse({ environmentId: CONVERSATION_ID, path: 'a.txt', offset: 3 }).success).toBe(true);
      expect(schema.safeParse({ environmentId: CONVERSATION_ID, path: 'a.txt', offset: 1.5 }).success).toBe(false);
    });

    it('editFile inputSchema: given an unrecognized field, should reject instead of silently dropping it', () => {
      const tools = createSandboxTools({ resolveEnvironment: ownSandbox, listEnvironments: noEnvironments, runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate });
      const schema = schemaOf(tools, 'editFile');
      expect(schema.safeParse({ environmentId: CONVERSATION_ID, path: 'a.txt', oldString: 'x', newString: 'y', cwd: 'PageSpace' }).success).toBe(false);
      expect(schema.safeParse({ environmentId: CONVERSATION_ID, path: 'a.txt', oldString: 'x', newString: 'y' }).success).toBe(true);
    });

    it('bash inputSchema: given a legitimate extra-looking but unknown field, should reject it', () => {
      const tools = createSandboxTools({ resolveEnvironment: ownSandbox, listEnvironments: noEnvironments, runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate });
      const schema = schemaOf(tools, 'bash');
      expect(schema.safeParse({ environmentId: CONVERSATION_ID, command: 'ls', bogus: true }).success).toBe(false);
      expect(schema.safeParse({ environmentId: CONVERSATION_ID, command: 'ls', cwd: 'PageSpace' }).success).toBe(true);
    });
  });

  it('editFile inputSchema: should require path/oldString/newString and accept replaceAll', () => {
    const tools = createSandboxTools({ resolveEnvironment: ownSandbox, listEnvironments: noEnvironments, runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate });
    const schema = tools.editFile.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ environmentId: CONVERSATION_ID, path: 'a', oldString: 'x', newString: 'y' }).success).toBe(true);
    expect(schema.safeParse({ environmentId: CONVERSATION_ID, path: 'a', oldString: 'x', newString: 'y', replaceAll: true }).success).toBe(true);
    expect(schema.safeParse({ environmentId: CONVERSATION_ID, path: 'a', oldString: 'x' }).success).toBe(false);
  });

  it('should expose exactly five tools: the four execution tools plus the ONE discovery tool they take their id from — no mutable machine directory remains', () => {
    const tools = createSandboxTools({ resolveEnvironment: ownSandbox, listEnvironments: noEnvironments, runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate });
    expect(Object.keys(tools).sort()).toEqual(['bash', 'editFile', 'list_environments', 'readFile', 'writeFile']);
    // The deleted apparatus stays deleted: there is no switch_machine, no
    // list_machines, and no way to CHANGE where later calls go.
    expect(Object.keys(tools)).not.toContain('switch_machine');
    expect(Object.keys(tools)).not.toContain('list_machines');
  });
});

describe('list_environments — the ONLY place an environment id comes from (leaf B)', () => {
  it('given the caller, should list the conversation\'s own sandbox plus the environments the store handed back', async () => {
    const rows = [{ id: 'env_dw9jthqyaza6ga3b6m5n', label: 'jono-macstudio', substrate: 'local' as const, driveId: 'drive_1' }];
    const tools = createSandboxTools({ resolveEnvironment: ownSandbox, listEnvironments: async () => rows, runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate });
    const result = (await exec(tools.list_environments, {}, {})) as { environments: { id: string; label: string; substrate: string; driveId: string | null; kind: string }[]; notice: string };
    expect(result.environments).toEqual([
      { id: CONVERSATION_ID, label: expect.any(String), substrate: 'sprite', driveId: 'd1', kind: 'conversation' },
      { id: 'env_dw9jthqyaza6ga3b6m5n', label: 'jono-macstudio', substrate: 'local', driveId: 'drive_1', kind: 'environment' },
    ]);
    expect(result.notice).toMatch(/copy it exactly/i);
  });

  it('the FILTERING is the store\'s, never the tool\'s: whatever the dep returns is what is listed, and the actor is passed to it', async () => {
    const seen: string[] = [];
    const tools = createSandboxTools({
      resolveEnvironment: ownSandbox,
      listEnvironments: async (actor) => {
        seen.push(actor.userId);
        return [];
      },
      runDeps: fakeRunDeps(),
      resolveContext: okResolve,
      gate: okGate,
    });
    const result = (await exec(tools.list_environments, {}, {})) as { environments: unknown[]; notice: string };
    expect(seen).toEqual(['u1']);
    // Nothing to copy — said in words, never as a bare empty list.
    expect(result.environments).toHaveLength(1);
    expect(result.notice).toMatch(/no other environments available/i);
  });

  it('given a denied gate, should refuse exactly as every other sandbox tool does — discovery is not a way around the kill-switch', async () => {
    const tools = createSandboxTools({
      resolveEnvironment: ownSandbox,
      listEnvironments: async () => {
        throw new Error('the store must never be reached on a denied gate');
      },
      runDeps: fakeRunDeps(),
      resolveContext: okResolve,
      gate: async () => ({ ok: false, reason: 'kill_switch_off', error: 'Code execution is disabled.' }),
    });
    expect(await exec(tools.list_environments, {}, {})).toEqual({ success: false, error: 'Code execution is disabled.' });
  });

  it('given an unresolvable context, should refuse without reaching the store', async () => {
    const tools = createSandboxTools({
      resolveEnvironment: ownSandbox,
      listEnvironments: async () => {
        throw new Error('the store must never be reached without an actor');
      },
      runDeps: fakeRunDeps(),
      resolveContext: async () => ({ error: 'Code execution requires a conversation.' }),
      gate: okGate,
    });
    expect(await exec(tools.list_environments, {}, {})).toEqual({ success: false, error: 'Code execution requires a conversation.' });
  });

  it('the description tells the model to copy an id from this list and never to construct one — July\'s post-mortem makes the wording part of the fix', () => {
    const tools = createSandboxTools({ resolveEnvironment: ownSandbox, listEnvironments: noEnvironments, runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate });
    const description = (tools.list_environments as { description?: string }).description ?? '';
    expect(description).toMatch(/copy an id from the output exactly/i);
    expect(description).toMatch(/never construct, guess, shorten or infer/i);
    expect(description).toMatch(/refused/i);
  });
});

describe('the MANDATORY, OPAQUE environmentId (leaf C)', () => {
  const tools = () =>
    createSandboxTools({ resolveEnvironment: ownSandbox, listEnvironments: noEnvironments, runDeps: fakeRunDeps(), resolveContext: okResolve, gate: okGate });
  const schemas = () => {
    const t = tools();
    return [
      ['bash', t.bash, { command: 'ls' }],
      ['writeFile', t.writeFile, { path: 'a.txt', content: 'x' }],
      ['readFile', t.readFile, { path: 'a.txt' }],
      ['editFile', t.editFile, { path: 'a.txt', oldString: 'a', newString: 'b' }],
    ] as const;
  };

  it('given a call with NO environment id, should fail schema validation on every one of the four tools — never fall back to the conversation\'s own sandbox', () => {
    for (const [name, toolDef, args] of schemas()) {
      const schema = toolDef.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
      expect(schema.safeParse(args).success, `${name} accepted a call with no environmentId`).toBe(false);
      expect(schema.safeParse({ ...args, environmentId: CONVERSATION_ID }).success, name).toBe(true);
    }
  });

  it('given the id FORMAT, should be constrained to the opaque id shape rather than free text — the values July saw invented are all refused', () => {
    for (const [name, toolDef, args] of schemas()) {
      const schema = toolDef.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
      for (const invented of ['main', 'staging', 'prod', 'my-machine', '/workspace/repo', 'jono-macstudio', '', 'C1', 'a'.repeat(64)]) {
        expect(schema.safeParse({ ...args, environmentId: invented }).success, `${name} accepted ${invented}`).toBe(false);
      }
      expect(schema.safeParse({ ...args, environmentId: CONVERSATION_ID }).success, name).toBe(true);
    }
  });

  it('given an environment id that does not exist, should refuse and NAME the discovery tool — a guessed id fails closed', async () => {
    const t = createSandboxTools({
      resolveEnvironment: async () => ({ ok: false, error: ENV_UNREACHABLE_MESSAGE }),
      listEnvironments: noEnvironments,
      runDeps: fakeRunDeps(),
      resolveContext: okResolve,
      gate: okGate,
    });
    const result = (await exec(t.bash, { environmentId: OTHER_ID, command: 'ls' }, {})) as { success: boolean; error: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain('list_environments');
    expect(result.error).toMatch(/never construct or guess one/i);
  });

  it('given an id the caller may not access, should refuse with the SAME sentence as an id that does not exist — a refusal never reveals existence', async () => {
    // Both refusals come from the one constant, which is the property: a
    // per-reason message would be the probe this is built to defeat.
    expect(ENV_UNREACHABLE_MESSAGE).not.toMatch(/exist|owner|visib|permission/i);
  });

  it('a refused environment never reaches the sandbox: no acquire, no run', async () => {
    const acquired: unknown[] = [];
    const runDeps = fakeRunDeps();
    runDeps.acquireSandbox = async (input) => {
      acquired.push(input);
      return { ok: true, sandboxId: 'sbx', resumed: false, workspaceId: 'ws-1' };
    };
    const t = createSandboxTools({
      resolveEnvironment: async () => ({ ok: false, error: ENV_UNREACHABLE_MESSAGE }),
      listEnvironments: noEnvironments,
      runDeps,
      resolveContext: okResolve,
      gate: okGate,
    });
    for (const call of [
      () => exec(t.bash, { environmentId: OTHER_ID, command: 'ls' }, {}),
      () => exec(t.writeFile, { environmentId: OTHER_ID, path: 'a', content: 'x' }, {}),
      () => exec(t.readFile, { environmentId: OTHER_ID, path: 'a' }, {}),
      () => exec(t.editFile, { environmentId: OTHER_ID, path: 'a', oldString: 'a', newString: 'b' }, {}),
    ]) {
      expect(await call()).toMatchObject({ success: false });
    }
    expect(acquired).toEqual([]);
  });

  it("given the conversation's OWN sandbox, should be addressed by its id exactly like any other environment — the resolved target rides the context to the runner", async () => {
    const seen: unknown[] = [];
    const runDeps = fakeRunDeps();
    runDeps.acquireSandbox = async (input) => {
      seen.push(input.environment);
      return { ok: true, sandboxId: 'sbx', resumed: false, workspaceId: 'ws-1' };
    };
    const t = createSandboxTools({ resolveEnvironment: ownSandbox, listEnvironments: noEnvironments, runDeps, resolveContext: okResolve, gate: okGate });
    await exec(t.bash, { environmentId: CONVERSATION_ID, command: 'ls' }, {});
    expect(seen).toEqual([{ id: CONVERSATION_ID, kind: 'conversation', label: "This conversation's own sandbox", driveId: 'd1' }]);
  });

  it('the id the model passed is what gets RESOLVED — the resolver, not the tool, decides where a call goes', async () => {
    const asked: string[] = [];
    const t = createSandboxTools({
      resolveEnvironment: async ({ environmentId }) => {
        asked.push(environmentId);
        return { ok: true, target: { id: environmentId, kind: 'environment', label: 'jono-macstudio', driveId: 'drive_1' } };
      },
      listEnvironments: noEnvironments,
      runDeps: fakeRunDeps(),
      resolveContext: okResolve,
      gate: okGate,
    });
    await exec(t.readFile, { environmentId: OTHER_ID, path: 'a.txt' }, {});
    expect(asked).toEqual([OTHER_ID]);
  });

  it("every execution tool's DESCRIPTION tells the model to copy an id from list_environments and never to construct one", () => {
    const t = tools();
    for (const name of ['bash', 'writeFile', 'readFile', 'editFile'] as const) {
      const description = (t[name] as { description?: string }).description ?? '';
      expect(description, name).toMatch(/copied EXACTLY from the output of list_environments/);
      expect(description, name).toMatch(/never constructed, guessed or described/i);
    }
  });
});
