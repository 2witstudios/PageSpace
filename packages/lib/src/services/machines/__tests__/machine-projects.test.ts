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
  for (const row of seed) rows.set(`${row.terminalId}\0${row.name}`, row);
  let counter = 0;
  const store: MachineProjectStore = {
    list: async (terminalId) => [...rows.values()].filter((r) => r.terminalId === terminalId),
    findByName: async (terminalId, name) => rows.get(`${terminalId}\0${name}`) ?? null,
    create: async (input) => {
      const k = `${input.terminalId}\0${input.name}`;
      if (rows.has(k)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      counter += 1;
      const row: MachineProjectRecord = {
        id: `proj-${counter}`,
        ownerId: input.ownerId,
        terminalId: input.terminalId,
        name: input.name,
        repoUrl: input.repoUrl,
        path: input.path,
        createdAt: input.now,
        updatedAt: input.now,
      };
      rows.set(k, row);
      return row;
    },
    remove: async (terminalId, name) => {
      rows.delete(`${terminalId}\0${name}`);
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
    acquireMachineSandbox: async (terminalId) => {
      acquireCalls.push(terminalId);
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
      path: `${PROJECTS_ROOT}/my-repo`,
    });
  });

  it('given a non-https repoUrl, should reject', () => {
    expect(planAddProject({ name: 'my-repo', repoUrl: 'git@github.com:o/r.git', existingNames: [] })).toEqual({
      ok: false,
      reason: 'invalid_repo_url',
    });
  });

  it('given an invalid name, should reject', () => {
    expect(planAddProject({ name: '../etc', repoUrl: 'https://github.com/o/r.git', existingNames: [] })).toEqual({
      ok: false,
      reason: 'invalid_name',
    });
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
      terminalId: TERMINAL_ID,
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
    // The clone ran against THIS machine's backing page (terminalId) — the same
    // persistent session a live Terminal shell already reconnects to.
    expect(acquireCalls).toEqual([TERMINAL_ID]);
  });

  it('given no GitHub token available (public repo), should still clone without token env vars', async () => {
    const { deps, runCommandCalls } = makeDeps({ resolveGitHubToken: async () => null });
    const result = await addProject({
      terminalId: TERMINAL_ID,
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
      terminalId: TERMINAL_ID,
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
      terminalId: TERMINAL_ID,
      name: 'my-repo',
      repoUrl: 'https://github.com/o/r.git',
      path: `${PROJECTS_ROOT}/my-repo`,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const { deps, runCommandCalls } = makeDeps({}, [existing]);
    const result = await addProject({
      terminalId: TERMINAL_ID,
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
      terminalId: TERMINAL_ID,
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
      terminalId: TERMINAL_ID,
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
      terminalId: 'terminal-2',
      name: 'other-repo',
      repoUrl: 'https://github.com/o/other.git',
      path: `${PROJECTS_ROOT}/other-repo`,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const mine: MachineProjectRecord = { ...other, id: 'p-mine', ownerId: 'user-1', terminalId: TERMINAL_ID, name: 'mine' };
    const { store } = makeStore([other, mine]);
    const result = await listProjects({ terminalId: TERMINAL_ID, store });
    expect(result).toEqual([mine]);
  });
});

describe('removeProject', () => {
  it('given an existing project, should rm -rf its directory and delete the tracking row', async () => {
    const existing: MachineProjectRecord = {
      id: 'p1',
      ownerId: 'user-1',
      terminalId: TERMINAL_ID,
      name: 'my-repo',
      repoUrl: 'https://github.com/o/r.git',
      path: `${PROJECTS_ROOT}/my-repo`,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const { deps, store, runCommandCalls } = makeDeps({}, [existing]);
    const result = await removeProject({ terminalId: TERMINAL_ID, name: 'my-repo', deps });
    expect(result).toEqual({ ok: true });
    expect(runCommandCalls).toMatchObject([{ cmd: 'rm', args: ['-rf', `${PROJECTS_ROOT}/my-repo`] }]);
    expect(await store.findByName(TERMINAL_ID, 'my-repo')).toBeNull();
  });

  it('given a non-existent project name, should return not_found without touching the sandbox', async () => {
    const { deps, runCommandCalls } = makeDeps();
    const result = await removeProject({ terminalId: TERMINAL_ID, name: 'nope', deps });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(runCommandCalls).toHaveLength(0);
  });

  it('given the sandbox is unreachable during cleanup, should still remove the tracking row (best-effort cleanup)', async () => {
    const existing: MachineProjectRecord = {
      id: 'p1',
      ownerId: 'user-1',
      terminalId: TERMINAL_ID,
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
    const result = await removeProject({ terminalId: TERMINAL_ID, name: 'my-repo', deps });
    expect(result).toEqual({ ok: true });
    expect(await store.findByName(TERMINAL_ID, 'my-repo')).toBeNull();
  });
});
