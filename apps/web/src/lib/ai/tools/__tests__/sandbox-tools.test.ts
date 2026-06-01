import { describe, it, expect, vi } from 'vitest';

// The module wires production DB-backed helpers at import time; stub those
// boundaries so the factory can be exercised with injected fakes (no DB, no
// real Vercel API). The tests only drive createSandboxTools.
vi.mock('@pagespace/db/db', () => ({ db: { query: {} } }));
vi.mock('@pagespace/db/operators', () => ({ eq: () => undefined }));
vi.mock('@pagespace/db/schema/core', () => ({ drives: {} }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: {} }));

import { createSandboxTools, type ResolveSandboxContext } from '../sandbox-tools';
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
      preflight: async () => ({ allowed: true }),
      charge: async () => {},
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
    const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve });
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
    });
    const result = await exec(tools.bash, { command: 'echo hi' }, {});
    expect(result).toEqual({ success: false, error: 'no drive' });
    expect(acquired).toBe(false);
  });

  it('writeFile: should delegate and report bytes written', async () => {
    const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve });
    const result = await exec(tools.writeFile, { path: 'a.txt', content: 'hello' }, {});
    expect(result).toMatchObject({ success: true, path: 'a.txt', bytesWritten: 5 });
  });

  it('readFile: should delegate and return file contents', async () => {
    const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve });
    const result = await exec(tools.readFile, { path: 'a.txt' }, {});
    expect(result).toMatchObject({ success: true, path: 'a.txt', content: 'data' });
  });

  it('bash inputSchema: should reject an empty command', () => {
    const tools = createSandboxTools({ runDeps: fakeRunDeps(), resolveContext: okResolve });
    const schema = tools.bash.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ command: '' }).success).toBe(false);
    expect(schema.safeParse({ command: 'ls' }).success).toBe(true);
  });
});
