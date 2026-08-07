import { describe, it, expect } from 'vitest';
import {
  spawnSessionShell,
  resolveSessionShellById,
  killSessionShellById,
  listSessionShells,
  toShellDTO,
} from '../workspace-shells';
import { shellDtoSchema } from '../../../agent-workspaces/contract';
import { SANDBOX_ROOT } from '../../sandbox/sandbox-paths';
import { NOW, OWNER_ID, SESSION_ID, makeSessionShellStore, makeShellRecord, makeSpriteHost } from './fakes';

const SANDBOX_ID = 'pgs-ses-abc';

function spawnDeps(store: ReturnType<typeof makeSessionShellStore>) {
  return { store: store.store, now: () => NOW };
}

describe('spawnSessionShell', () => {
  it('given no name, should auto-label shell-1 and reserve the row', async () => {
    const store = makeSessionShellStore();
    const result = await spawnSessionShell({ workspaceId: SESSION_ID, ownerId: OWNER_ID, deps: spawnDeps(store) });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.shell.name).toBe('shell-1');
    expect(result.shell.workspaceId).toBe(SESSION_ID);
    expect(result.shell.agentType).toBe('shell');
    expect(store.rows.size).toBe(1);
  });

  it('should reserve the ROW ONLY — no Sprite, no PTY (the bridge opens it lazily on first connect)', async () => {
    // The deps this function accepts are the proof: there is no host and no
    // provisioning seam to reach for.
    const store = makeSessionShellStore();
    const deps = spawnDeps(store);
    expect(Object.keys(deps)).toEqual(['store', 'now']);
    const result = await spawnSessionShell({ workspaceId: SESSION_ID, ownerId: OWNER_ID, deps });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(store.rows.get(result.shell.shellId)!.spriteExecId).toBeNull();
  });

  it('given existing shells, should auto-label the next ordinal', async () => {
    const store = makeSessionShellStore([
      makeShellRecord({ id: 'a', name: 'shell-1' }),
      makeShellRecord({ id: 'b', name: 'shell-2' }),
    ]);
    const result = await spawnSessionShell({ workspaceId: SESSION_ID, ownerId: OWNER_ID, deps: spawnDeps(store) });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.shell.name).toBe('shell-3');
  });

  it('given an auto-label that would collide with a renamed shell, should advance past it', async () => {
    const store = makeSessionShellStore([makeShellRecord({ id: 'a', name: 'shell-2' })]);
    const result = await spawnSessionShell({ workspaceId: SESSION_ID, ownerId: OWNER_ID, deps: spawnDeps(store) });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.shell.name).toBe('shell-3');
  });

  it('given a requested name, should use it', async () => {
    const store = makeSessionShellStore();
    const result = await spawnSessionShell({
      workspaceId: SESSION_ID,
      ownerId: OWNER_ID,
      name: 'build-watch',
      deps: spawnDeps(store),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.shell.name).toBe('build-watch');
  });

  it('given a duplicate requested name, should reject rather than silently rename', async () => {
    const store = makeSessionShellStore([makeShellRecord({ id: 'a', name: 'build-watch' })]);
    const result = await spawnSessionShell({
      workspaceId: SESSION_ID,
      ownerId: OWNER_ID,
      name: 'build-watch',
      deps: spawnDeps(store),
    });

    expect(result).toEqual({ ok: false, reason: 'name_taken' });
  });

  it('given a name only used in ANOTHER session, should accept it — uniqueness is per session', async () => {
    const store = makeSessionShellStore([makeShellRecord({ id: 'a', workspaceId: 'conv-other', name: 'build' })]);
    const result = await spawnSessionShell({
      workspaceId: SESSION_ID,
      ownerId: OWNER_ID,
      name: 'build',
      deps: spawnDeps(store),
    });

    expect(result.ok).toBe(true);
  });

  it('given an invalid name, should reject it', async () => {
    const store = makeSessionShellStore();
    const result = await spawnSessionShell({
      workspaceId: SESSION_ID,
      ownerId: OWNER_ID,
      name: '../etc',
      deps: spawnDeps(store),
    });

    expect(result).toEqual({ ok: false, reason: 'invalid_name' });
  });

  it('given an unknown agent type, should reject it', async () => {
    const store = makeSessionShellStore();
    const result = await spawnSessionShell({
      workspaceId: SESSION_ID,
      ownerId: OWNER_ID,
      agentType: 'pagespace',
      deps: spawnDeps(store),
    });

    expect(result).toEqual({ ok: false, reason: 'invalid_agent_type' });
    expect(store.rows.size).toBe(0);
  });

  it('given a command override, should record it; given an empty one, should reject', async () => {
    const store = makeSessionShellStore();
    const ok = await spawnSessionShell({
      workspaceId: SESSION_ID,
      ownerId: OWNER_ID,
      command: 'htop',
      deps: spawnDeps(store),
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error('unreachable');
    expect(ok.shell.command).toBe('htop');

    const bad = await spawnSessionShell({
      workspaceId: SESSION_ID,
      ownerId: OWNER_ID,
      command: '   ',
      deps: spawnDeps(store),
    });
    expect(bad).toEqual({ ok: false, reason: 'invalid_command' });
  });

  it('given a lost race on the unique index, should report name_taken', async () => {
    const store = makeSessionShellStore();
    const deps = {
      store: {
        ...store.store,
        list: async () => [],
        create: async () => {
          throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
        },
      },
      now: () => NOW,
    };
    expect(await spawnSessionShell({ workspaceId: SESSION_ID, ownerId: OWNER_ID, deps })).toEqual({
      ok: false,
      reason: 'name_taken',
    });
  });

  it('given an unrelated store failure, should report a generic error', async () => {
    const store = makeSessionShellStore();
    const deps = {
      store: { ...store.store, create: async () => { throw new Error('db down'); } },
      now: () => NOW,
    };
    expect(await spawnSessionShell({ workspaceId: SESSION_ID, ownerId: OWNER_ID, deps })).toEqual({
      ok: false,
      reason: 'error',
    });
  });
});

describe('resolveSessionShellById', () => {
  it('given a known shell, should resolve it at the sandbox home — a session has no scope checkout', async () => {
    const store = makeSessionShellStore([makeShellRecord({ id: 'shell-x', spriteExecId: 'stream-1' })]);
    const result = await resolveSessionShellById({ shellId: 'shell-x', deps: { store: store.store } });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.shell.shellId).toBe('shell-x');
    expect(result.cwd).toBe(SANDBOX_ROOT);
    expect(result.spriteExecId).toBe('stream-1');
  });

  it('should resolve WITHOUT waking a Sprite — the re-auth tick must stay cheap', async () => {
    const store = makeSessionShellStore([makeShellRecord({ id: 'shell-x' })]);
    const deps = { store: store.store };
    expect(Object.keys(deps)).toEqual(['store']);
    expect((await resolveSessionShellById({ shellId: 'shell-x', deps })).ok).toBe(true);
  });

  it('given an unknown shell, should report not_found', async () => {
    const store = makeSessionShellStore();
    expect(await resolveSessionShellById({ shellId: 'nope', deps: { store: store.store } })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});

describe('killSessionShellById', () => {
  function killDeps(
    store: ReturnType<typeof makeSessionShellStore>,
    host: ReturnType<typeof makeSpriteHost>,
    sandboxId: string | null = SANDBOX_ID,
  ) {
    return { store: store.store, host: host.host, resolveSessionSandboxId: async () => sandboxId };
  }

  it('given a shell with a live PTY, should kill that PTY session and drop the row', async () => {
    const store = makeSessionShellStore([makeShellRecord({ id: 'shell-x', spriteExecId: 'stream-1' })]);
    const host = makeSpriteHost({ seed: { [SANDBOX_ID]: { instanceId: 'inst-1' } } });
    const result = await killSessionShellById({ shellId: 'shell-x', deps: killDeps(store, host) });

    expect(result).toEqual({ ok: true, killed: true });
    expect(store.rows.has('shell-x')).toBe(false);
  });

  it('should NOT destroy the session\'s sandbox — every other shell in it keeps running', async () => {
    const store = makeSessionShellStore([
      makeShellRecord({ id: 'shell-x', spriteExecId: 'stream-1' }),
      makeShellRecord({ id: 'shell-y', name: 'shell-2' }),
    ]);
    const host = makeSpriteHost({ seed: { [SANDBOX_ID]: { instanceId: 'inst-1' } } });
    await killSessionShellById({ shellId: 'shell-x', deps: killDeps(store, host) });

    expect(host.calls.kill).toHaveLength(0);
    expect(host.live.has(SANDBOX_ID)).toBe(true);
    expect(store.rows.has('shell-y')).toBe(true);
  });

  it('given a shell that never opened a PTY, should drop the row without touching the host', async () => {
    const store = makeSessionShellStore([makeShellRecord({ id: 'shell-x' })]);
    const host = makeSpriteHost();
    const result = await killSessionShellById({ shellId: 'shell-x', deps: killDeps(store, host) });

    expect(result).toEqual({ ok: true, killed: true });
    expect(host.calls.attach).toHaveLength(0);
    expect(store.rows.has('shell-x')).toBe(false);
  });

  it('given a shell that is already gone, should report SUCCESS — teardown is idempotent', async () => {
    // Every caller of this is a cleanup path that retries. Making "already gone"
    // an error is what forces each of them to keep their own in-flight registry.
    const store = makeSessionShellStore();
    const result = await killSessionShellById({
      shellId: 'never-existed',
      deps: killDeps(store, makeSpriteHost()),
    });

    expect(result).toEqual({ ok: true, killed: false });
  });

  it('given a session whose sandbox is gone, should still drop the row', async () => {
    const store = makeSessionShellStore([makeShellRecord({ id: 'shell-x', spriteExecId: 'stream-1' })]);
    const host = makeSpriteHost();
    const result = await killSessionShellById({
      shellId: 'shell-x',
      deps: killDeps(store, host, null),
    });

    expect(result).toEqual({ ok: true, killed: true });
    expect(store.rows.has('shell-x')).toBe(false);
  });

  it('given a vanished sandbox that the host cannot attach to, should still drop the row', async () => {
    const store = makeSessionShellStore([makeShellRecord({ id: 'shell-x', spriteExecId: 'stream-1' })]);
    const host = makeSpriteHost(); // nothing live under SANDBOX_ID
    const result = await killSessionShellById({ shellId: 'shell-x', deps: killDeps(store, host) });

    expect(result).toEqual({ ok: true, killed: true });
    expect(store.rows.has('shell-x')).toBe(false);
  });

  it('given an unreachable control plane, should KEEP the row so a retry can find the process', async () => {
    const store = makeSessionShellStore([makeShellRecord({ id: 'shell-x', spriteExecId: 'stream-1' })]);
    const host = makeSpriteHost({ attachError: new Error('control plane down') });
    const result = await killSessionShellById({ shellId: 'shell-x', deps: killDeps(store, host) });

    expect(result).toEqual({ ok: false, reason: 'error' });
    expect(store.rows.has('shell-x')).toBe(true);
  });

  it('given a PTY kill that fails, should KEEP the row rather than strand a running process', async () => {
    const store = makeSessionShellStore([makeShellRecord({ id: 'shell-x', spriteExecId: 'stream-1' })]);
    const host = makeSpriteHost({ seed: { [SANDBOX_ID]: { instanceId: 'inst-1' } } });
    const deps = {
      store: store.store,
      resolveSessionSandboxId: async () => SANDBOX_ID,
      host: {
        ...host.host,
        attach: async () => ({
          ...(await host.host.attach({ sandboxId: SANDBOX_ID }))!,
          killSession: async () => {
            throw new Error('kill endpoint failed');
          },
        }),
      },
    };
    const result = await killSessionShellById({ shellId: 'shell-x', deps });

    expect(result).toEqual({ ok: false, reason: 'error' });
    expect(store.rows.has('shell-x')).toBe(true);
  });
});

describe('listSessionShells', () => {
  it('should return one DTO per shell in the session', async () => {
    const store = makeSessionShellStore([
      makeShellRecord({ id: 'a', name: 'shell-1' }),
      makeShellRecord({ id: 'b', name: 'shell-2' }),
      makeShellRecord({ id: 'c', workspaceId: 'conv-other', name: 'shell-1' }),
    ]);
    const shells = await listSessionShells({ workspaceId: SESSION_ID, deps: { store: store.store } });

    expect(shells.map((shell) => shell.shellId)).toEqual(['a', 'b']);
    expect(shells.every((shell) => shellDtoSchema.safeParse(shell).success)).toBe(true);
  });

  it('should list a row with an unrecognized agentType rather than hide it', async () => {
    // Hiding it would make it undiscoverable, and therefore unkillable, while its
    // PTY kept running.
    const store = makeSessionShellStore([makeShellRecord({ id: 'a', agentType: 'pagespace-cli' })]);
    const shells = await listSessionShells({ workspaceId: SESSION_ID, deps: { store: store.store } });
    expect(shells).toHaveLength(1);
  });
});

describe('toShellDTO', () => {
  it('should address the shell by id and emit ISO timestamps', () => {
    const dto = toShellDTO(makeShellRecord({ id: 'shell-x' }));
    expect(dto.shellId).toBe('shell-x');
    expect(dto.createdAt).toBe(NOW.toISOString());
    expect(shellDtoSchema.safeParse(dto).success).toBe(true);
  });

  it('should carry NO Sprite columns — the session owns the VM, a shell owns a process', () => {
    const dto = toShellDTO(makeShellRecord());
    for (const key of ['sandboxId', 'spriteInstanceId', 'spriteKey', 'egressPolicyToken']) {
      expect(dto).not.toHaveProperty(key);
    }
  });
});
