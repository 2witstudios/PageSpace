import { describe, it, expect } from 'vitest';
import {
  planSpawnBranch,
  spawnBranch,
  attachBranch,
  killBranch,
  listBranches,
  BRANCH_REPO_PATH,
  type MachineBranchesDeps,
  type MachineBranchProjectLookup,
} from '../machine-branches';
import type { MachineBranchStore, MachineBranchRecord } from '../machine-branches-store';
import type { MachineHost, MachineHandle } from '../../sandbox/machine-host';
import type { RunCommandArgs, SandboxRunResult } from '../../sandbox/sandbox-client/types';
import { SANDBOX_ROOT } from '../../sandbox/sandbox-paths';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const TERMINAL_ID = 'terminal-1';
const PROJECT_NAME = 'my-repo';
const REPO_URL = 'https://github.com/o/r.git';
const SECRET = 'a'.repeat(32);

const actor = {
  userId: 'user-1',
  tenantId: 'user-1',
  actorEmail: 'user-1@example.com',
  tier: 'pro' as const,
};

function makeStore(seed: MachineBranchRecord[] = []) {
  const rows = new Map<string, MachineBranchRecord>();
  const key = (terminalId: string, projectName: string, branchName: string) => `${terminalId}\0${projectName}\0${branchName}`;
  for (const row of seed) rows.set(key(row.terminalId, row.projectName, row.branchName), row);
  let counter = 0;
  const store: MachineBranchStore = {
    list: async (terminalId, projectName) =>
      [...rows.values()].filter((r) => r.terminalId === terminalId && r.projectName === projectName),
    findByName: async (terminalId, projectName, branchName) => rows.get(key(terminalId, projectName, branchName)) ?? null,
    create: async (input) => {
      const k = key(input.terminalId, input.projectName, input.branchName);
      if (rows.has(k)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      counter += 1;
      const row: MachineBranchRecord = {
        id: `branch-${counter}`,
        ownerId: input.ownerId,
        terminalId: input.terminalId,
        projectName: input.projectName,
        branchName: input.branchName,
        sessionKey: input.sessionKey,
        sandboxId: input.sandboxId,
        createdAt: input.now,
        updatedAt: input.now,
      };
      rows.set(k, row);
      return row;
    },
    updateSandboxId: async ({ id, sandboxId, now }) => {
      for (const [k, row] of rows) {
        if (row.id === id) rows.set(k, { ...row, sandboxId, updatedAt: now });
      }
    },
    remove: async (terminalId, projectName, branchName) => {
      rows.delete(key(terminalId, projectName, branchName));
    },
  };
  return { store, rows };
}

function makeProjectStore(repoUrl: string | null = REPO_URL): MachineBranchProjectLookup {
  return {
    findByName: async () => (repoUrl ? { repoUrl } : null),
  };
}

interface SpriteState {
  machineId: string;
  execLog: RunCommandArgs[];
  files: Map<string, string>;
}

/**
 * A fake `MachineHost` that gives each provisioned NAME its own independent
 * in-memory Sprite state (exec log + filesystem) — modeling the real
 * contract: `provision` auto-resumes by name (same name -> same Sprite), and
 * two DIFFERENT names never share state. This is what proves the isolation
 * acceptance criterion below: two branches provisioned under two different
 * derived session keys get two completely independent "filesystems".
 */
function makeFakeHost(execImpl?: (state: SpriteState, args: RunCommandArgs) => SandboxRunResult) {
  const byName = new Map<string, SpriteState>();
  const byId = new Map<string, SpriteState>();
  const provisionCalls: string[] = [];
  const killCalls: string[] = [];
  let counter = 0;

  function makeHandle(state: SpriteState): MachineHandle {
    return {
      machineId: state.machineId,
      exec: async (args) => {
        state.execLog.push(args);
        return execImpl ? execImpl(state, args) : { exitCode: 0, stdout: '', stderr: '' };
      },
      writeFiles: async (files) => {
        for (const f of files) state.files.set(f.path, String(f.content));
      },
      readFile: async ({ path }) => {
        const content = state.files.get(path);
        return content === undefined ? null : Buffer.from(content);
      },
      stream: async () => {
        throw new Error('not used by machine-branches');
      },
      listStreams: async () => [],
    };
  }

  const host: MachineHost = {
    provision: async ({ name }) => {
      provisionCalls.push(name);
      let state = byName.get(name);
      if (!state) {
        counter += 1;
        state = { machineId: `sbx-${counter}`, execLog: [], files: new Map() };
        byName.set(name, state);
        byId.set(state.machineId, state);
      }
      return makeHandle(state);
    },
    attach: async ({ machineId }) => {
      const state = byId.get(machineId);
      return state ? makeHandle(state) : null;
    },
    kill: async ({ machineId }) => {
      killCalls.push(machineId);
      const state = byId.get(machineId);
      if (state) {
        byId.delete(machineId);
        for (const [name, s] of byName) if (s === state) byName.delete(name);
      }
    },
  };
  return { host, byName, byId, provisionCalls, killCalls };
}

function makeDeps(overrides: Partial<MachineBranchesDeps> = {}, storeSeed: MachineBranchRecord[] = []) {
  const { store } = makeStore(storeSeed);
  const { host } = makeFakeHost();
  const auditCalls: unknown[] = [];
  const deps: MachineBranchesDeps = {
    store,
    projectStore: makeProjectStore(),
    isEnabled: () => true,
    now: () => NOW,
    host,
    substrate: { kind: 'sprite' },
    options: {},
    secret: SECRET,
    checkFullEgressEnablement: async () => ({ ok: true }),
    resolveGitHubToken: async () => 'ghp_secret_token',
    quota: { acquireSlot: () => true, releaseSlot: () => {} },
    buildEnv: () => ({ NODE_ENV: 'test' }),
    audit: async (input) => {
      auditCalls.push(input);
    },
    ...overrides,
  };
  return { deps, store, host, auditCalls };
}

describe('planSpawnBranch', () => {
  it('given a valid branch name, should accept', () => {
    expect(planSpawnBranch({ branchName: 'feature/foo' })).toEqual({ ok: true });
  });

  it('given an invalid branch name, should reject', () => {
    expect(planSpawnBranch({ branchName: '../etc' })).toEqual({ ok: false, reason: 'invalid_branch_name' });
  });
});

describe('spawnBranch', () => {
  it('given a valid spawn, should provision exactly one Sprite, clone the repo, checkout the branch off origin, and persist the row', async () => {
    const { host, provisionCalls, byId } = makeFakeHost();
    const { deps, store } = makeDeps({ host });

    const result = await spawnBranch({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });

    expect(result).toMatchObject({ ok: true, resumed: false });
    if (!result.ok) throw new Error('expected ok');
    expect(provisionCalls).toHaveLength(1);

    const row = await store.findByName(TERMINAL_ID, PROJECT_NAME, 'main');
    expect(row).toMatchObject({ sandboxId: result.sandboxId, branchName: 'main', projectName: PROJECT_NAME });

    const state = byId.get(result.sandboxId);
    expect(state?.execLog).toEqual([
      { cmd: 'git', args: ['clone', REPO_URL, BRANCH_REPO_PATH], cwd: SANDBOX_ROOT, env: expect.any(Object), timeoutMs: expect.any(Number), maxBytes: expect.any(Number) },
      { cmd: 'git', args: ['checkout', '-b', 'main', 'origin/main'], cwd: BRANCH_REPO_PATH, env: expect.any(Object), timeoutMs: expect.any(Number), maxBytes: expect.any(Number) },
    ]);
    // Token is injected into env for these commands only, never persisted.
    expect(state?.execLog[0]?.env).toMatchObject({ GH_TOKEN: 'ghp_secret_token', GITHUB_TOKEN: 'ghp_secret_token' });
  });

  it('given the kill switch is off, should refuse without touching the host', async () => {
    const { host, provisionCalls } = makeFakeHost();
    const { deps } = makeDeps({ host, isEnabled: () => false });

    const result = await spawnBranch({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    expect(result).toEqual({ ok: false, reason: 'kill_switch_off' });
    expect(provisionCalls).toHaveLength(0);
  });

  it('given an invalid branch name, should refuse before looking up the project', async () => {
    let lookedUp = false;
    const { deps } = makeDeps({
      projectStore: {
        findByName: async () => {
          lookedUp = true;
          return { repoUrl: REPO_URL };
        },
      },
    });
    const result = await spawnBranch({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: '../etc', actor, deps });
    expect(result).toEqual({ ok: false, reason: 'invalid_branch_name' });
    expect(lookedUp).toBe(false);
  });

  it('given no such project on this machine, should refuse', async () => {
    const { deps } = makeDeps({ projectStore: makeProjectStore(null) });
    const result = await spawnBranch({ terminalId: TERMINAL_ID, projectName: 'nope', branchName: 'main', actor, deps });
    expect(result).toEqual({ ok: false, reason: 'project_not_found' });
  });

  it('given containment is unverified, should refuse without provisioning', async () => {
    const { host, provisionCalls } = makeFakeHost();
    const { deps } = makeDeps({ host, checkFullEgressEnablement: async () => ({ ok: false, reason: 'containment_unverified' }) });

    const result = await spawnBranch({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    expect(result).toEqual({ ok: false, reason: 'containment_unverified' });
    expect(provisionCalls).toHaveLength(0);
  });

  it('given git clone fails, should kill the freshly provisioned Sprite and not persist a row', async () => {
    const { host, killCalls } = makeFakeHost((_state, args) => {
      if (args.cmd === 'git' && args.args?.[0] === 'clone') {
        return { exitCode: 128, stdout: '', stderr: 'fatal: repository not found' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const { deps, store } = makeDeps({ host });

    const result = await spawnBranch({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    expect(result).toMatchObject({ ok: false, reason: 'clone_failed' });
    expect(killCalls).toHaveLength(1);
    expect(await store.list(TERMINAL_ID, PROJECT_NAME)).toEqual([]);
  });

  it('given the branch does not exist upstream, should fall back to creating a fresh local branch', async () => {
    const checkoutAttempts: (string[] | undefined)[] = [];
    const { host } = makeFakeHost((_state, args) => {
      if (args.cmd === 'git' && args.args?.[0] === 'checkout') {
        checkoutAttempts.push(args.args);
        if (args.args?.includes('origin/feature-new')) {
          return { exitCode: 1, stdout: '', stderr: "fatal: 'origin/feature-new' is not a commit" };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const { deps } = makeDeps({ host });

    const result = await spawnBranch({
      terminalId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: 'feature-new',
      actor,
      deps,
    });
    expect(result.ok).toBe(true);
    expect(checkoutAttempts).toEqual([
      ['checkout', '-b', 'feature-new', 'origin/feature-new'],
      ['checkout', '-b', 'feature-new'],
    ]);
  });

  it('given both checkout attempts fail, should report checkout_failed and kill the Sprite', async () => {
    const { host, killCalls } = makeFakeHost((_state, args) => {
      if (args.cmd === 'git' && args.args?.[0] === 'checkout') {
        return { exitCode: 1, stdout: '', stderr: 'checkout failed' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const { deps, store } = makeDeps({ host });

    const result = await spawnBranch({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    expect(result).toMatchObject({ ok: false, reason: 'checkout_failed' });
    expect(killCalls).toHaveLength(1);
    expect(await store.list(TERMINAL_ID, PROJECT_NAME)).toEqual([]);
  });

  it('given an already-spawned branch with a live Sprite, should resume without re-cloning', async () => {
    const { host, provisionCalls } = makeFakeHost();
    const { deps } = makeDeps({ host });

    const first = await spawnBranch({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    expect(first).toMatchObject({ ok: true, resumed: false });

    const second = await spawnBranch({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    expect(second).toMatchObject({ ok: true, resumed: true });
    if (!first.ok || !second.ok) throw new Error('expected ok');
    expect(second.sandboxId).toBe(first.sandboxId);
    // Only ONE provision call — resume reattaches instead of re-provisioning.
    expect(provisionCalls).toHaveLength(1);
  });

  it('given a tracked branch whose Sprite has vanished, should re-provision under the SAME session key', async () => {
    const { host, provisionCalls } = makeFakeHost();
    const { deps, store } = makeDeps({ host });

    const first = await spawnBranch({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    if (!first.ok) throw new Error('expected ok');

    const before = await store.findByName(TERMINAL_ID, PROJECT_NAME, 'main');
    // Simulate the Sprite vanishing (reaped) without going through killBranch.
    await host.kill({ machineId: first.sandboxId });

    const second = await spawnBranch({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    expect(second).toMatchObject({ ok: true, resumed: false });
    if (!second.ok) throw new Error('expected ok');

    const after = await store.findByName(TERMINAL_ID, PROJECT_NAME, 'main');
    expect(after?.sessionKey).toBe(before?.sessionKey);
    expect(after?.sandboxId).toBe(second.sandboxId);
    expect(provisionCalls).toEqual([before?.sessionKey, before?.sessionKey]);
  });

  it('given no GitHub token available (public repo), should still clone without token env vars', async () => {
    const { host, byId } = makeFakeHost();
    const { deps } = makeDeps({ host, resolveGitHubToken: async () => null });

    const result = await spawnBranch({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    const state = byId.get(result.sandboxId);
    expect(state?.execLog[0]?.env).not.toHaveProperty('GH_TOKEN');
    expect(state?.execLog[0]?.env).not.toHaveProperty('GITHUB_TOKEN');
  });
});

describe('spawnBranch — isolation between two branches of one project', () => {
  it('should provision two DIFFERENT Sprites under two different session keys', async () => {
    const { host, provisionCalls } = makeFakeHost();
    const { deps } = makeDeps({ host });

    const a = await spawnBranch({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'branch-a', actor, deps });
    const b = await spawnBranch({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'branch-b', actor, deps });
    if (!a.ok || !b.ok) throw new Error('expected both spawns to succeed');

    expect(a.sandboxId).not.toBe(b.sandboxId);
    expect(provisionCalls).toHaveLength(2);
    expect(new Set(provisionCalls).size).toBe(2);
  });

  it("a file written into branch A's Sprite must be ABSENT from branch B's Sprite (no shared filesystem)", async () => {
    const { host } = makeFakeHost();
    const { deps } = makeDeps({ host });

    const a = await spawnBranch({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'branch-a', actor, deps });
    const b = await spawnBranch({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'branch-b', actor, deps });
    if (!a.ok || !b.ok) throw new Error('expected both spawns to succeed');

    const handleA = await host.attach({ machineId: a.sandboxId });
    const handleB = await host.attach({ machineId: b.sandboxId });
    if (!handleA || !handleB) throw new Error('expected both handles to be live');

    await handleA.writeFiles([{ path: `${BRANCH_REPO_PATH}/MARKER`, content: 'only-in-branch-a' }]);

    expect((await handleA.readFile({ path: `${BRANCH_REPO_PATH}/MARKER` }))?.toString('utf8')).toBe('only-in-branch-a');
    expect(await handleB.readFile({ path: `${BRANCH_REPO_PATH}/MARKER` })).toBeNull();
  });

  it("each branch's clone+checkout only ever runs against its OWN Sprite's exec log", async () => {
    const { host, byId } = makeFakeHost();
    const { deps } = makeDeps({ host });

    const a = await spawnBranch({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'branch-a', actor, deps });
    const b = await spawnBranch({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'branch-b', actor, deps });
    if (!a.ok || !b.ok) throw new Error('expected both spawns to succeed');

    const stateA = byId.get(a.sandboxId);
    const stateB = byId.get(b.sandboxId);

    expect(stateA?.execLog.some((c) => c.args?.includes('branch-a'))).toBe(true);
    expect(stateA?.execLog.some((c) => c.args?.includes('branch-b'))).toBe(false);
    expect(stateB?.execLog.some((c) => c.args?.includes('branch-b'))).toBe(true);
    expect(stateB?.execLog.some((c) => c.args?.includes('branch-a'))).toBe(false);
  });
});

describe('attachBranch', () => {
  it('given an existing, live branch, should reattach to its Sprite', async () => {
    const { host } = makeFakeHost();
    const { deps, store } = makeDeps({ host });
    const spawned = await spawnBranch({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    if (!spawned.ok) throw new Error('expected ok');

    const result = await attachBranch({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', store, host });
    expect(result).toEqual({ ok: true, sandboxId: spawned.sandboxId });
  });

  it('given no tracked branch, should return not_found', async () => {
    const { host } = makeFakeHost();
    const { store } = makeDeps({ host });
    const result = await attachBranch({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'nope', store, host });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('given a tracked branch whose Sprite has vanished, should return vanished', async () => {
    const { host } = makeFakeHost();
    const { deps, store } = makeDeps({ host });
    const spawned = await spawnBranch({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    if (!spawned.ok) throw new Error('expected ok');

    await host.kill({ machineId: spawned.sandboxId });

    const result = await attachBranch({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', store, host });
    expect(result).toEqual({ ok: false, reason: 'vanished' });
  });
});

describe('killBranch', () => {
  it('given an existing branch, should DELETE its Sprite through the MachineHost seam and drop the tracking row', async () => {
    const { host, killCalls } = makeFakeHost();
    const { deps, store } = makeDeps({ host });
    const spawned = await spawnBranch({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    if (!spawned.ok) throw new Error('expected ok');

    const result = await killBranch({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', store, host });
    expect(result).toEqual({ ok: true });
    expect(killCalls).toContain(spawned.sandboxId);
    expect(await store.findByName(TERMINAL_ID, PROJECT_NAME, 'main')).toBeNull();
  });

  it('given no such tracked branch, should return not_found without touching the host', async () => {
    const { host, killCalls } = makeFakeHost();
    const { store } = makeDeps({ host });
    const result = await killBranch({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'nope', store, host });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(killCalls).toHaveLength(0);
  });

  it('given the Sprite is unreachable, should keep the tracking row so a retry can still find it (no orphans)', async () => {
    const { host } = makeFakeHost();
    const { deps, store } = makeDeps({ host });
    const spawned = await spawnBranch({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    if (!spawned.ok) throw new Error('expected ok');

    const failingHost: MachineHost = {
      ...host,
      kill: async () => {
        throw new Error('unreachable');
      },
    };

    const result = await killBranch({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', store, host: failingHost });
    expect(result).toEqual({ ok: false, reason: 'error' });
    expect(await store.findByName(TERMINAL_ID, PROJECT_NAME, 'main')).not.toBeNull();
  });
});

describe('listBranches', () => {
  it('given branches tracked on a project, should list only that project\'s branches', async () => {
    const { host } = makeFakeHost();
    const { deps, store } = makeDeps({ host });
    await spawnBranch({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    await spawnBranch({
      terminalId: TERMINAL_ID,
      projectName: 'other-repo',
      branchName: 'main',
      actor,
      deps: { ...deps, projectStore: makeProjectStore(REPO_URL) },
    });

    const result = await listBranches({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, store });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ branchName: 'main', projectName: PROJECT_NAME });
  });
});
