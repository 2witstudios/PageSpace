import { describe, it, expect } from 'vitest';
import {
  planAddProject,
  addProject,
  listProjects,
  removeProject,
  type MachineProjectsDeps,
} from '../machine-projects';
import type { MachineProjectStore, MachineProjectRecord } from '../machine-projects-store';
import type { ExecutableSandbox, SandboxRunResult } from '../../sandbox/sandbox-client/types';
import { PROJECTS_ROOT } from '../project-paths';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const TERMINAL_ID = 'terminal-1';

const actor = {
  userId: 'user-1',
  tenantId: 'user-1',
  actorEmail: 'user-1@example.com',
  tier: 'pro' as const,
};

function makeStore(seed: MachineProjectRecord[] = []) {
  const rows = new Map<string, MachineProjectRecord>();
  for (const row of seed) rows.set(`${row.machineId}\0${row.name}`, row);
  let counter = 0;
  const store: MachineProjectStore = {
    list: async (machineId) => [...rows.values()].filter((r) => r.machineId === machineId),
    findByName: async (machineId, name) => rows.get(`${machineId}\0${name}`) ?? null,
    create: async (input) => {
      const k = `${input.machineId}\0${input.name}`;
      if (rows.has(k)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      counter += 1;
      const row: MachineProjectRecord = {
        id: `proj-${counter}`,
        ownerId: input.ownerId,
        machineId: input.machineId,
        name: input.name,
        repoUrl: input.repoUrl,
        path: input.path,
        createdAt: input.now,
        updatedAt: input.now,
      };
      rows.set(k, row);
      return row;
    },
    remove: async (machineId, name) => {
      rows.delete(`${machineId}\0${name}`);
    },
  };
  return { store, rows };
}

function makeSandbox(runCommandImpl?: (opts: Parameters<ExecutableSandbox['runCommand']>[0]) => Promise<SandboxRunResult>) {
  const runCommandCalls: Array<Parameters<ExecutableSandbox['runCommand']>[0]> = [];
  const sandbox: ExecutableSandbox = {
    sandboxId: 'sbx-1',
    runCommand: async (opts) => {
      runCommandCalls.push(opts);
      return runCommandImpl ? runCommandImpl(opts) : { exitCode: 0, stdout: '', stderr: '' };
    },
    writeFiles: async () => {
      throw new Error('writeFiles should never be called by clone/remove — no persisted credentials');
    },
    readFileToBuffer: async () => null,
  };
  return { sandbox, runCommandCalls };
}

function makeDeps(overrides: Partial<MachineProjectsDeps> = {}, storeSeed: MachineProjectRecord[] = []) {
  const { store } = makeStore(storeSeed);
  const { sandbox, runCommandCalls } = makeSandbox();
  const slotCalls = { acquired: 0, released: 0 };
  const auditCalls: unknown[] = [];
  const acquireCalls: string[] = [];
  const deps: MachineProjectsDeps = {
    store,
    isEnabled: () => true,
    now: () => NOW,
    acquireMachineSandbox: async (machineId) => {
      acquireCalls.push(machineId);
      return { ok: true, sandboxId: 'sbx-1', resumed: false };
    },
    reconnect: async () => sandbox,
    resolveGitHubToken: async () => 'ghp_secret_token',
    quota: {
      acquireSlot: () => { slotCalls.acquired += 1; return true; },
      releaseSlot: () => { slotCalls.released += 1; },
    },
    buildEnv: () => ({ NODE_ENV: 'test' }),
    audit: async (input) => { auditCalls.push(input); },
    ...overrides,
  };
  return { deps, store, sandbox, runCommandCalls, slotCalls, auditCalls, acquireCalls };
}

describe('planAddProject', () => {
  it('given a valid name and https repoUrl, should accept and resolve the path', () => {
    expect(planAddProject({ name: 'my-repo', repoUrl: 'https://github.com/o/r.git', existingNames: [] })).toEqual({
      ok: true,
      name: 'my-repo',
      path: `${PROJECTS_ROOT}/my-repo`,
    });
  });

  it('given a non-https repoUrl, should reject', () => {
    expect(planAddProject({ name: 'my-repo', repoUrl: 'git@github.com:o/r.git', existingNames: [] })).toEqual({
      ok: false,
      reason: 'invalid_repo_url',
    });
  });

  it('given free text as the name, should NORMALIZE it rather than reject, and clone into the normalized path', () => {
    expect(planAddProject({ name: 'My Cool Feature', repoUrl: 'https://github.com/o/r.git', existingNames: [] })).toEqual({
      ok: true,
      name: 'my-cool-feature',
      path: `${PROJECTS_ROOT}/my-cool-feature`,
    });
  });

  it('given a traversal attempt as the name, should normalize it into a confined slug rather than reject', () => {
    expect(planAddProject({ name: '../etc', repoUrl: 'https://github.com/o/r.git', existingNames: [] })).toEqual({
      ok: true,
      name: 'etc',
      path: `${PROJECTS_ROOT}/etc`,
    });
  });

  it('given a name that normalizes onto an existing project, should reject as duplicate', () => {
    expect(
      planAddProject({ name: 'My Repo', repoUrl: 'https://github.com/o/r.git', existingNames: ['my-repo'] }),
    ).toEqual({ ok: false, reason: 'duplicate_name' });
  });

  it('given a name already on the machine, should reject as duplicate', () => {
    expect(
      planAddProject({ name: 'my-repo', repoUrl: 'https://github.com/o/r.git', existingNames: ['my-repo'] }),
    ).toEqual({ ok: false, reason: 'duplicate_name' });
  });
});

describe('addProject', () => {
  it('given a valid clone, should run git clone with the token injected per-command and persist the project', async () => {
    const { deps, runCommandCalls, auditCalls, acquireCalls } = makeDeps();
    const result = await addProject({
      machineId: TERMINAL_ID,
      actor,
      name: 'my-repo',
      repoUrl: 'https://github.com/o/r.git',
      deps,
    });

    expect(result).toMatchObject({ ok: true, project: { name: 'my-repo', path: `${PROJECTS_ROOT}/my-repo` } });
    expect(runCommandCalls).toHaveLength(1);
    expect(runCommandCalls[0]).toMatchObject({
      cmd: 'git',
      args: ['clone', 'https://github.com/o/r.git', `${PROJECTS_ROOT}/my-repo`],
    });
    // Token is injected into env for this one call only.
    expect(runCommandCalls[0].env).toMatchObject({ GH_TOKEN: 'ghp_secret_token', GITHUB_TOKEN: 'ghp_secret_token' });
    expect(auditCalls).toHaveLength(1);
    // The clone ran against THIS machine's backing page (machineId) — the same
    // persistent session a live Terminal shell already reconnects to.
    expect(acquireCalls).toEqual([TERMINAL_ID]);
  });

  it('given free text as the name, should clone into the NORMALIZED path and persist the normalized name', async () => {
    const { deps, store, runCommandCalls } = makeDeps();
    const result = await addProject({
      machineId: TERMINAL_ID,
      actor,
      name: 'My Cool Feature',
      repoUrl: 'https://github.com/o/r.git',
      deps,
    });

    expect(result).toMatchObject({
      ok: true,
      project: { name: 'my-cool-feature', path: `${PROJECTS_ROOT}/my-cool-feature` },
    });
    expect(runCommandCalls[0]).toMatchObject({
      args: ['clone', 'https://github.com/o/r.git', `${PROJECTS_ROOT}/my-cool-feature`],
    });
    // The persisted row must match the directory that was actually cloned —
    // storing the raw text would desync the two.
    expect(await store.findByName(TERMINAL_ID, 'my-cool-feature')).toMatchObject({ name: 'my-cool-feature' });
    expect(await store.findByName(TERMINAL_ID, 'My Cool Feature')).toBeNull();
  });

  it("given two concurrent adds whose names normalize alike, should NOT rm -rf the winner's checkout", async () => {
    // The real interleaving, not a convenient one: B's clone fails the INSTANT
    // A's directory appears — long before A's row is committed. Any guard that
    // looks for A's row at cleanup time therefore sees nothing and deletes A's
    // freshly cloned files. The only fix is to reserve the name BEFORE cloning,
    // so B loses on the unique constraint and never touches the filesystem.
    // Normalization widens this race from "same text" to "same slug".
    const { store } = makeStore();
    const dirs = new Set<string>();
    const rmCalls: string[] = [];

    function depsFor() {
      const { sandbox } = makeSandbox(async (opts) => {
        if (opts.cmd === 'rm') {
          const target = opts.args?.[1] ?? '';
          rmCalls.push(target);
          dirs.delete(target);
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        const dest = opts.args?.[2] ?? '';
        if (dirs.has(dest)) {
          // git fails the INSTANT the destination exists — it does not wait for
          // the other clone to finish.
          return { exitCode: 128, stdout: '', stderr: 'fatal: destination path already exists and is not empty' };
        }
        // Real git creates the directory immediately and finishes cloning later;
        // the row is only written after THAT. This delay is the point of the test —
        // it puts the loser's failure and cleanup strictly BEFORE the winner's row
        // exists, which is precisely the ordering a post-clone guard cannot see.
        dirs.add(dest);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { exitCode: 0, stdout: '', stderr: '' };
      });
      const { deps } = makeDeps({ store, reconnect: async () => sandbox });
      return deps;
    }

    // "My Repo" and "my repo" both normalize to `my-repo` — one directory, one row.
    const [a, b] = await Promise.all([
      addProject({ machineId: TERMINAL_ID, actor, name: 'My Repo', repoUrl: 'https://github.com/o/r.git', deps: depsFor() }),
      addProject({ machineId: TERMINAL_ID, actor, name: 'my repo', repoUrl: 'https://github.com/o/r.git', deps: depsFor() }),
    ]);

    const outcomes = [a, b];
    expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
    expect(outcomes.filter((r) => !r.ok && r.reason === 'duplicate_name')).toHaveLength(1);

    // The winner's checkout survives, and the surviving row points at it.
    const rows = await store.list(TERMINAL_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'my-repo', path: `${PROJECTS_ROOT}/my-repo` });
    expect(dirs.has(`${PROJECTS_ROOT}/my-repo`)).toBe(true);
    expect(rmCalls).toEqual([]);
  });

  it('given no GitHub token available (public repo), should still clone without token env vars', async () => {
    const { deps, runCommandCalls } = makeDeps({ resolveGitHubToken: async () => null });
    const result = await addProject({
      machineId: TERMINAL_ID,
      actor,
      name: 'public-repo',
      repoUrl: 'https://github.com/o/public.git',
      deps,
    });
    expect(result.ok).toBe(true);
    expect(runCommandCalls[0].env).not.toHaveProperty('GH_TOKEN');
    expect(runCommandCalls[0].env).not.toHaveProperty('GITHUB_TOKEN');
  });

  it('given an invalid repo url, should reject before touching the sandbox', async () => {
    const { deps, runCommandCalls } = makeDeps();
    const result = await addProject({
      machineId: TERMINAL_ID,
      actor,
      name: 'my-repo',
      repoUrl: 'ssh://git@github.com/o/r.git',
      deps,
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_repo_url' });
    expect(runCommandCalls).toHaveLength(0);
  });

  it('given a duplicate project name already tracked, should reject before cloning', async () => {
    const existing: MachineProjectRecord = {
      id: 'p1',
      ownerId: 'user-1',
      machineId: TERMINAL_ID,
      name: 'my-repo',
      repoUrl: 'https://github.com/o/r.git',
      path: `${PROJECTS_ROOT}/my-repo`,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const { deps, runCommandCalls } = makeDeps({}, [existing]);
    const result = await addProject({
      machineId: TERMINAL_ID,
      actor,
      name: 'my-repo',
      repoUrl: 'https://github.com/o/r.git',
      deps,
    });
    expect(result).toEqual({ ok: false, reason: 'duplicate_name' });
    expect(runCommandCalls).toHaveLength(0);
  });

  it('given git clone exits non-zero, should clean up the partial directory and not persist a project row', async () => {
    let rmCalls = 0;
    const sandbox: ExecutableSandbox = {
      sandboxId: 'sbx-1',
      runCommand: async (opts) => {
        if (opts.cmd === 'git') return { exitCode: 128, stdout: '', stderr: 'fatal: repository not found' };
        if (opts.cmd === 'rm') { rmCalls += 1; return { exitCode: 0, stdout: '', stderr: '' }; }
        throw new Error(`unexpected cmd ${opts.cmd}`);
      },
      writeFiles: async () => {},
      readFileToBuffer: async () => null,
    };
    const { deps, store } = makeDeps({ reconnect: async () => sandbox });
    const result = await addProject({
      machineId: TERMINAL_ID,
      actor,
      name: 'bad-repo',
      repoUrl: 'https://github.com/o/missing.git',
      deps,
    });
    expect(result).toMatchObject({ ok: false, reason: 'clone_failed' });
    expect(rmCalls).toBe(1);
    expect(await store.list(TERMINAL_ID)).toEqual([]);
  });

  it('given the kill switch is off, should refuse without touching the sandbox', async () => {
    const { deps, runCommandCalls } = makeDeps({ isEnabled: () => false });
    const result = await addProject({
      machineId: TERMINAL_ID,
      actor,
      name: 'my-repo',
      repoUrl: 'https://github.com/o/r.git',
      deps,
    });
    expect(result).toEqual({ ok: false, reason: 'kill_switch_off' });
    expect(runCommandCalls).toHaveLength(0);
  });
});

describe('listProjects', () => {
  it('given projects on a machine, should list only that machine\'s projects', async () => {
    const other: MachineProjectRecord = {
      id: 'p-other',
      ownerId: 'user-2',
      machineId: 'terminal-2',
      name: 'other-repo',
      repoUrl: 'https://github.com/o/other.git',
      path: `${PROJECTS_ROOT}/other-repo`,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const mine: MachineProjectRecord = { ...other, id: 'p-mine', ownerId: 'user-1', machineId: TERMINAL_ID, name: 'mine' };
    const { store } = makeStore([other, mine]);
    const result = await listProjects({ machineId: TERMINAL_ID, store });
    expect(result).toEqual([mine]);
  });
});

describe('removeProject', () => {
  it('given the free text the project was CREATED with, should normalize the lookup and still remove it', async () => {
    // `addProject` persists the CANONICAL name, so a raw-name lookup would 404
    // — whatever text created a project must also be able to delete it.
    const { deps, store } = makeDeps();
    const added = await addProject({
      machineId: TERMINAL_ID,
      actor,
      name: 'My Cool Feature',
      repoUrl: 'https://github.com/o/r.git',
      deps,
    });
    expect(added).toMatchObject({ ok: true, project: { name: 'my-cool-feature' } });

    const result = await removeProject({ machineId: TERMINAL_ID, name: 'My Cool Feature', deps });

    expect(result).toEqual({ ok: true });
    expect(await store.findByName(TERMINAL_ID, 'my-cool-feature')).toBeNull();
  });

  it('given an existing project, should rm -rf its directory and delete the tracking row', async () => {
    const existing: MachineProjectRecord = {
      id: 'p1',
      ownerId: 'user-1',
      machineId: TERMINAL_ID,
      name: 'my-repo',
      repoUrl: 'https://github.com/o/r.git',
      path: `${PROJECTS_ROOT}/my-repo`,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const { deps, store, runCommandCalls } = makeDeps({}, [existing]);
    const result = await removeProject({ machineId: TERMINAL_ID, name: 'my-repo', deps });
    expect(result).toEqual({ ok: true });
    expect(runCommandCalls).toMatchObject([{ cmd: 'rm', args: ['-rf', `${PROJECTS_ROOT}/my-repo`] }]);
    expect(await store.findByName(TERMINAL_ID, 'my-repo')).toBeNull();
  });

  it('given a non-existent project name, should return not_found without touching the sandbox', async () => {
    const { deps, runCommandCalls } = makeDeps();
    const result = await removeProject({ machineId: TERMINAL_ID, name: 'nope', deps });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(runCommandCalls).toHaveLength(0);
  });

  it('given the sandbox is unreachable during cleanup, should still remove the tracking row (best-effort cleanup)', async () => {
    const existing: MachineProjectRecord = {
      id: 'p1',
      ownerId: 'user-1',
      machineId: TERMINAL_ID,
      name: 'my-repo',
      repoUrl: 'https://github.com/o/r.git',
      path: `${PROJECTS_ROOT}/my-repo`,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const { deps, store } = makeDeps(
      { acquireMachineSandbox: async () => ({ ok: false, reason: 'error' }) },
      [existing],
    );
    const result = await removeProject({ machineId: TERMINAL_ID, name: 'my-repo', deps });
    expect(result).toEqual({ ok: true });
    expect(await store.findByName(TERMINAL_ID, 'my-repo')).toBeNull();
  });
});
