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

function makeRecord(overrides: Partial<MachineProjectRecord> = {}): MachineProjectRecord {
  return {
    id: 'p1',
    ownerId: 'user-1',
    machineId: TERMINAL_ID,
    name: 'my-repo',
    repoUrl: 'https://github.com/o/r.git',
    path: `${PROJECTS_ROOT}/my-repo-p1`,
    // Unpromoted: a project lives on the owning Machine's Sprite until
    // `promoteProject` gives it one of its own (machine-project-promotion.ts).
    sessionKey: null,
    sandboxId: null,
    spriteInstanceId: null,
    teardownRequestedAt: null,
    spriteTornDownAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeStore(seed: MachineProjectRecord[] = []) {
  // Keyed by row id — the (machineId, name) uniqueness is enforced by scan in
  // `create`, mirroring the DB's unique index vs primary key split.
  const rows = new Map<string, MachineProjectRecord>();
  for (const row of seed) rows.set(row.id, row);
  const removeCalls: Array<{ machineId: string; id: string }> = [];
  const store: MachineProjectStore = {
    list: async (machineId) => [...rows.values()].filter((r) => r.machineId === machineId),
    findByName: async (machineId, name) =>
      [...rows.values()].find((r) => r.machineId === machineId && r.name === name) ?? null,
    findById: async (id) => rows.get(id) ?? null,
    // Promotion CAS — exercised by machine-project-promotion.test.ts; here it
    // only has to exist and honour the compare, since nothing in this file
    // promotes.
    promote: async ({ id, previousSandboxId, sessionKey, sandboxId, spriteInstanceId, now }) => {
      const row = rows.get(id);
      if (!row || row.sandboxId !== previousSandboxId) return false;
      rows.set(id, { ...row, sessionKey, sandboxId, spriteInstanceId, spriteTornDownAt: null, teardownRequestedAt: null, updatedAt: now });
      return true;
    },
    create: async (input) => {
      const duplicate = [...rows.values()].some(
        (r) => r.machineId === input.machineId && r.name === input.name,
      );
      if (duplicate || rows.has(input.id)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      const row: MachineProjectRecord = makeRecord({
        id: input.id,
        ownerId: input.ownerId,
        machineId: input.machineId,
        name: input.name,
        repoUrl: input.repoUrl,
        path: input.path,
        createdAt: input.now,
        updatedAt: input.now,
      });
      rows.set(input.id, row);
      return row;
    },
    remove: async (machineId, id) => {
      removeCalls.push({ machineId, id });
      const row = rows.get(id);
      if (row && row.machineId === machineId) rows.delete(id);
    },
  };
  return { store, rows, removeCalls };
}

function makeSandbox(runCommandImpl?: (opts: Parameters<ExecutableSandbox['runCommand']>[0]) => Promise<SandboxRunResult>) {
  const runCommandCalls: Array<Parameters<ExecutableSandbox['runCommand']>[0]> = [];
  const sandbox: ExecutableSandbox = {
    sandboxId: 'sbx-1',
    spriteInstanceId: null,
    runCommand: async (opts) => {
      runCommandCalls.push(opts);
      return runCommandImpl ? runCommandImpl(opts) : { exitCode: 0, stdout: '', stderr: '' };
    },
    writeFiles: async () => {
      throw new Error('writeFiles should never be called by clone/remove — no persisted credentials');
    },
    readFileToBuffer: async () => null,
    createCheckpoint: async () => {},
  };
  return { sandbox, runCommandCalls };
}

function makeDeps(overrides: Partial<MachineProjectsDeps> = {}, storeSeed: MachineProjectRecord[] = []) {
  const { store, removeCalls } = makeStore(storeSeed);
  const { sandbox, runCommandCalls } = makeSandbox();
  const slotCalls = { acquired: 0, released: 0 };
  const auditCalls: unknown[] = [];
  const acquireCalls: string[] = [];
  let idCounter = 0;
  const deps: MachineProjectsDeps = {
    store,
    isEnabled: () => true,
    now: () => NOW,
    // Deterministic ids: the FIRST add in a test gets `id1`, the second `id2`.
    newProjectId: () => { idCounter += 1; return `id${idCounter}`; },
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
  return { deps, store, removeCalls, sandbox, runCommandCalls, slotCalls, auditCalls, acquireCalls };
}

describe('planAddProject', () => {
  it('given a valid name and https repoUrl, should accept and resolve the PER-ROW path', () => {
    expect(
      planAddProject({ name: 'my-repo', repoUrl: 'https://github.com/o/r.git', existingNames: [], projectId: 'id1' }),
    ).toEqual({
      ok: true,
      name: 'my-repo',
      path: `${PROJECTS_ROOT}/my-repo-id1`,
    });
  });

  it('given the SAME name planned under two different row ids, should resolve two DIFFERENT paths', () => {
    // The TOCTOU fix: concurrent same-name adds can never share a directory.
    const a = planAddProject({ name: 'my-repo', repoUrl: 'https://github.com/o/r.git', existingNames: [], projectId: 'ida' });
    const b = planAddProject({ name: 'my-repo', repoUrl: 'https://github.com/o/r.git', existingNames: [], projectId: 'idb' });
    if (!a.ok || !b.ok) throw new Error('expected both plans to be ok');
    expect(a.path).not.toBe(b.path);
  });

  it('given a non-https repoUrl, should reject', () => {
    expect(
      planAddProject({ name: 'my-repo', repoUrl: 'git@github.com:o/r.git', existingNames: [], projectId: 'id1' }),
    ).toEqual({
      ok: false,
      reason: 'invalid_repo_url',
    });
  });

  it('given free text as the name, should NORMALIZE it rather than reject, and clone into the normalized path', () => {
    expect(
      planAddProject({ name: 'My Cool Feature', repoUrl: 'https://github.com/o/r.git', existingNames: [], projectId: 'id1' }),
    ).toEqual({
      ok: true,
      name: 'my-cool-feature',
      path: `${PROJECTS_ROOT}/my-cool-feature-id1`,
    });
  });

  it('given a traversal attempt as the name, should normalize it into a confined slug rather than reject', () => {
    expect(
      planAddProject({ name: '../etc', repoUrl: 'https://github.com/o/r.git', existingNames: [], projectId: 'id1' }),
    ).toEqual({
      ok: true,
      name: 'etc',
      path: `${PROJECTS_ROOT}/etc-id1`,
    });
  });

  it('given a malformed row id, should THROW — a bad id is a wiring fault, not user input to blame as invalid_name', () => {
    expect(() =>
      planAddProject({ name: 'my-repo', repoUrl: 'https://github.com/o/r.git', existingNames: [], projectId: '../up' }),
    ).toThrow(/newProjectId/);
    expect(() =>
      planAddProject({
        name: 'my-repo',
        repoUrl: 'https://github.com/o/r.git',
        existingNames: [],
        // A UUID — valid-looking to a future refactor, but not the cuid2 the
        // path scheme (and the rm -rf confinement) is built around.
        projectId: '123e4567-e89b-42d3-a456-426614174000',
      }),
    ).toThrow(/newProjectId/);
  });

  it('given a name that normalizes onto an existing project, should reject as duplicate', () => {
    expect(
      planAddProject({ name: 'My Repo', repoUrl: 'https://github.com/o/r.git', existingNames: ['my-repo'], projectId: 'id1' }),
    ).toEqual({ ok: false, reason: 'duplicate_name' });
  });

  it('given a name already on the machine, should reject as duplicate', () => {
    expect(
      planAddProject({ name: 'my-repo', repoUrl: 'https://github.com/o/r.git', existingNames: ['my-repo'], projectId: 'id1' }),
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

    expect(result).toMatchObject({
      ok: true,
      project: { id: 'id1', name: 'my-repo', path: `${PROJECTS_ROOT}/my-repo-id1` },
    });
    expect(runCommandCalls).toHaveLength(1);
    expect(runCommandCalls[0]).toMatchObject({
      cmd: 'git',
      args: ['clone', 'https://github.com/o/r.git', `${PROJECTS_ROOT}/my-repo-id1`],
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
      project: { name: 'my-cool-feature', path: `${PROJECTS_ROOT}/my-cool-feature-id1` },
    });
    expect(runCommandCalls[0]).toMatchObject({
      args: ['clone', 'https://github.com/o/r.git', `${PROJECTS_ROOT}/my-cool-feature-id1`],
    });
    // The persisted row must match the directory that was actually cloned —
    // storing the raw text would desync the two.
    expect(await store.findByName(TERMINAL_ID, 'my-cool-feature')).toMatchObject({ name: 'my-cool-feature' });
    expect(await store.findByName(TERMINAL_ID, 'My Cool Feature')).toBeNull();
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
    // A LEGACY name-based path on the seeded row on purpose: the duplicate
    // check is by NAME, so pre-per-row-path rows still block a same-name add.
    const existing = makeRecord({ path: `${PROJECTS_ROOT}/my-repo` });
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

  it('given git clone exits non-zero, should clean up ONLY its own per-row directory and not persist a project row', async () => {
    const rmTargets: string[] = [];
    const sandbox: ExecutableSandbox = {
      sandboxId: 'sbx-1',
      spriteInstanceId: null,
      runCommand: async (opts) => {
        if (opts.cmd === 'git') return { exitCode: 128, stdout: '', stderr: 'fatal: repository not found' };
        if (opts.cmd === 'rm') { rmTargets.push(opts.args?.[1] ?? ''); return { exitCode: 0, stdout: '', stderr: '' }; }
        throw new Error(`unexpected cmd ${opts.cmd}`);
      },
      writeFiles: async () => {},
      readFileToBuffer: async () => null,
      createCheckpoint: async () => {},
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
    // The id-suffixed path THIS operation owns — never a shared by-name one.
    expect(rmTargets).toEqual([`${PROJECTS_ROOT}/bad-repo-id1`]);
    expect(await store.list(TERMINAL_ID)).toEqual([]);
  });

  it('given the clone times out / throws (no exit code at all), should still clean up its own per-row directory', async () => {
    // Under per-row paths an uncleaned partial clone is PERMANENT garbage (no
    // row points at it, no retry reuses the id) — the old shared by-name dir
    // was reclaimed by the next attempt, this one never is.
    const rmTargets: string[] = [];
    const sandbox: ExecutableSandbox = {
      sandboxId: 'sbx-1',
      spriteInstanceId: null,
      runCommand: async (opts) => {
        if (opts.cmd === 'git') throw new Error('deadline exceeded');
        if (opts.cmd === 'rm') { rmTargets.push(opts.args?.[1] ?? ''); return { exitCode: 0, stdout: '', stderr: '' }; }
        throw new Error(`unexpected cmd ${opts.cmd}`);
      },
      writeFiles: async () => {},
      readFileToBuffer: async () => null,
      createCheckpoint: async () => {},
    };
    const { deps, store } = makeDeps({ reconnect: async () => sandbox });
    const result = await addProject({
      machineId: TERMINAL_ID,
      actor,
      name: 'big-repo',
      repoUrl: 'https://github.com/o/big.git',
      deps,
    });
    expect(result).toMatchObject({ ok: false, reason: 'clone_failed' });
    expect(rmTargets).toEqual([`${PROJECTS_ROOT}/big-repo-id1`]);
    expect(await store.list(TERMINAL_ID)).toEqual([]);
  });

  it('given two CONCURRENT adds of the same name, should never rm -rf the winner\'s checkout', async () => {
    // The by-name TOCTOU this module used to document: both adds pass the
    // duplicate pre-check (both list before either persists), both clone, and
    // one loses at the row insert. Pre-fix they shared ONE by-name directory
    // and the loser's cleanup deleted the winner's fresh checkout. Now each
    // clones into its own per-row directory, so the loser cleans up only its
    // own orphaned clone.
    const { deps, store, runCommandCalls } = makeDeps();

    const [a, b] = await Promise.all([
      addProject({ machineId: TERMINAL_ID, actor, name: 'my-repo', repoUrl: 'https://github.com/o/r.git', deps }),
      addProject({ machineId: TERMINAL_ID, actor, name: 'My Repo', repoUrl: 'https://github.com/o/r.git', deps }),
    ]);

    const results = [a, b];
    const winner = results.find((r) => r.ok);
    const loser = results.find((r) => !r.ok);
    if (!winner?.ok || !loser || loser.ok) throw new Error('expected exactly one winner and one loser');
    expect(loser.reason).toBe('duplicate_name');

    // Both cloned — into two DIFFERENT directories.
    const clonePaths = runCommandCalls.filter((c) => c.cmd === 'git').map((c) => c.args?.[2]);
    expect(clonePaths).toHaveLength(2);
    expect(new Set(clonePaths).size).toBe(2);

    // Exactly one cleanup, of the LOSER's directory — the winner's checkout
    // and row both survive.
    const rmTargets = runCommandCalls.filter((c) => c.cmd === 'rm').map((c) => c.args?.[1]);
    const loserPath = clonePaths.find((p) => p !== winner.project.path);
    expect(rmTargets).toEqual([loserPath]);
    expect(rmTargets).not.toContain(winner.project.path);
    const rows = await store.list(TERMINAL_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: winner.project.id, name: 'my-repo', path: winner.project.path });
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
    const other = makeRecord({
      id: 'pother',
      ownerId: 'user-2',
      machineId: 'terminal-2',
      name: 'other-repo',
      path: `${PROJECTS_ROOT}/other-repo-pother`,
    });
    const mine = makeRecord({ id: 'pmine', name: 'mine', path: `${PROJECTS_ROOT}/mine-pmine` });
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

  it('given an existing project, should rm -rf ONLY that row\'s own directory and delete the row BY ID', async () => {
    const existing = makeRecord();
    const { deps, store, removeCalls, runCommandCalls } = makeDeps({}, [existing]);
    const result = await removeProject({ machineId: TERMINAL_ID, name: 'my-repo', deps });
    expect(result).toEqual({ ok: true });
    // The row's PERSISTED path — never one re-derived from the name.
    expect(runCommandCalls).toMatchObject([{ cmd: 'rm', args: ['-rf', `${PROJECTS_ROOT}/my-repo-p1`] }]);
    // Id-scoped delete: a concurrent remove-then-re-add of this name would
    // have a different row id, which this call must not touch.
    expect(removeCalls).toEqual([{ machineId: TERMINAL_ID, id: 'p1' }]);
    expect(await store.findByName(TERMINAL_ID, 'my-repo')).toBeNull();
  });

  it('given a LEGACY row whose path is name-based (pre-per-row paths), should still remove exactly that path', async () => {
    // Back-compat: rows created before per-row clone paths persisted
    // `PROJECTS_ROOT/<name>`. Removal reads the row's stored path, so they
    // keep resolving with no migration.
    const legacy = makeRecord({
      id: 'legacyid',
      name: 'old-repo',
      repoUrl: 'https://github.com/o/old.git',
      path: `${PROJECTS_ROOT}/old-repo`,
    });
    const { deps, store, removeCalls, runCommandCalls } = makeDeps({}, [legacy]);
    const result = await removeProject({ machineId: TERMINAL_ID, name: 'old-repo', deps });
    expect(result).toEqual({ ok: true });
    expect(runCommandCalls).toMatchObject([{ cmd: 'rm', args: ['-rf', `${PROJECTS_ROOT}/old-repo`] }]);
    expect(removeCalls).toEqual([{ machineId: TERMINAL_ID, id: 'legacyid' }]);
    expect(await store.list(TERMINAL_ID)).toEqual([]);
  });

  it('given a PROMOTED project with a live Sprite, should identity-guarded-kill it BEFORE deleting the row', async () => {
    // A promoted project's Sprite is a real billing microVM findable only via
    // this row. Deleting the row without the kill would leave the VM running
    // with only the DB trigger's outbox pointer between it and billing forever.
    const promoted = makeRecord({
      sessionKey: 'sess-key-1',
      sandboxId: 'pgs-sbx-proj',
      spriteInstanceId: 'inst-proj',
    });
    const killCalls: Array<{ sandboxId: string; spriteInstanceId: string | null }> = [];
    const { deps, store } = makeDeps(
      {
        killSprite: async (input) => {
          killCalls.push(input);
          return { ok: true };
        },
      },
      [promoted],
    );

    const result = await removeProject({ machineId: TERMINAL_ID, name: 'my-repo', deps });

    expect(result).toEqual({ ok: true });
    expect(killCalls).toEqual([{ sandboxId: 'pgs-sbx-proj', spriteInstanceId: 'inst-proj' }]);
    expect(await store.findByName(TERMINAL_ID, 'my-repo')).toBeNull();
  });

  it('given the promoted Sprite kill FAILS, should still remove the row — the delete trigger rescues the pointer', async () => {
    const promoted = makeRecord({
      sessionKey: 'sess-key-1',
      sandboxId: 'pgs-sbx-proj',
      spriteInstanceId: 'inst-proj',
    });
    const { deps, store } = makeDeps(
      { killSprite: async () => ({ ok: false }) },
      [promoted],
    );

    const result = await removeProject({ machineId: TERMINAL_ID, name: 'my-repo', deps });

    expect(result).toEqual({ ok: true });
    expect(await store.findByName(TERMINAL_ID, 'my-repo')).toBeNull();
  });

  it('given an UNPROMOTED project, should never call the Sprite kill', async () => {
    const existing = makeRecord();
    const killCalls: unknown[] = [];
    const { deps } = makeDeps(
      {
        killSprite: async (input) => {
          killCalls.push(input);
          return { ok: true };
        },
      },
      [existing],
    );

    await removeProject({ machineId: TERMINAL_ID, name: 'my-repo', deps });

    expect(killCalls).toEqual([]);
  });

  it('given an already-torn-down promoted project, should not re-kill the reused Sprite name', async () => {
    // sandboxId is a NAME reused across re-creates: killing it again could
    // destroy a replacement VM that legitimately took the name.
    const tornDown = makeRecord({
      sessionKey: 'sess-key-1',
      sandboxId: 'pgs-sbx-proj',
      spriteInstanceId: 'inst-proj',
      spriteTornDownAt: NOW,
    });
    const killCalls: unknown[] = [];
    const { deps } = makeDeps(
      {
        killSprite: async (input) => {
          killCalls.push(input);
          return { ok: true };
        },
      },
      [tornDown],
    );

    await removeProject({ machineId: TERMINAL_ID, name: 'my-repo', deps });

    expect(killCalls).toEqual([]);
  });

  it('given a non-existent project name, should return not_found without touching the sandbox', async () => {
    const { deps, runCommandCalls } = makeDeps();
    const result = await removeProject({ machineId: TERMINAL_ID, name: 'nope', deps });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(runCommandCalls).toHaveLength(0);
  });

  it('given the sandbox is unreachable during cleanup, should still remove the tracking row (best-effort cleanup)', async () => {
    const existing = makeRecord();
    const { deps, store } = makeDeps(
      { acquireMachineSandbox: async () => ({ ok: false, reason: 'error' }) },
      [existing],
    );
    const result = await removeProject({ machineId: TERMINAL_ID, name: 'my-repo', deps });
    expect(result).toEqual({ ok: true });
    expect(await store.findByName(TERMINAL_ID, 'my-repo')).toBeNull();
  });
});
