import { describe, it, expect } from 'vitest';
import {
  promoteProject,
  isPromotedProject,
  PROJECT_REPO_PATH,
  type PromoteProjectDeps,
  type ProjectStorageMeasurement,
} from '../machine-project-promotion';
import type { MachineProjectRecord, MachineProjectStore } from '../machine-projects-store';
import { deriveProjectSessionKey } from '../project-session';
import { PROJECTS_ROOT } from '../project-paths';
import type { MachineHost, MachineHandle } from '../../sandbox/machine-host';
import type { ExecutableSandbox, RunCommandArgs, SandboxRunResult } from '../../sandbox/sandbox-client/types';

const NOW = new Date('2026-07-01T12:00:00.000Z');
const MACHINE_ID = 'machine-1';
const PROJECT_NAME = 'my-repo';
const PROJECT_ID = 'p1';
const PROJECT_PATH = `${PROJECTS_ROOT}/my-repo-p1`;
const REPO_URL = 'https://github.com/o/r.git';
const SECRET = 'a'.repeat(32);
const MACHINE_SANDBOX_ID = 'sbx-machine';

const actor = {
  userId: 'user-1',
  tenantId: 'user-1',
  actorEmail: 'user-1@example.com',
  tier: 'pro' as const,
};

function makeRecord(overrides: Partial<MachineProjectRecord> = {}): MachineProjectRecord {
  return {
    id: PROJECT_ID,
    ownerId: 'user-1',
    machineId: MACHINE_ID,
    name: PROJECT_NAME,
    repoUrl: REPO_URL,
    path: PROJECT_PATH,
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

function makeStore(seed: MachineProjectRecord[] = [makeRecord()]) {
  const rows = new Map<string, MachineProjectRecord>();
  for (const row of seed) rows.set(row.id, row);
  const promoteCalls: Array<{ id: string; previousSandboxId: string | null; sandboxId: string }> = [];

  const store: Pick<MachineProjectStore, 'findByName' | 'findById' | 'promote'> = {
    findByName: async (machineId, name) =>
      [...rows.values()].find((r) => r.machineId === machineId && r.name === name) ?? null,
    findById: async (id) => rows.get(id) ?? null,
    promote: async ({ id, previousSandboxId, sessionKey, sandboxId, spriteInstanceId, now }) => {
      promoteCalls.push({ id, previousSandboxId, sandboxId });
      const row = rows.get(id);
      if (!row) return false;
      // Mirrors the real CAS: the write lands only while the row still holds
      // exactly the sandboxId the caller read.
      if (row.sandboxId !== previousSandboxId) return false;
      rows.set(id, {
        ...row,
        sessionKey,
        sandboxId,
        spriteInstanceId,
        spriteTornDownAt: null,
        teardownRequestedAt: null,
        updatedAt: now,
      });
      return true;
    },
  };
  return { store, rows, promoteCalls };
}

interface SpriteState {
  machineId: string;
  execLog: RunCommandArgs[];
  files: Map<string, string>;
}

/** Same fake-host contract as machine-branches.test.ts: provision auto-resumes BY NAME, and two names never share state. */
function makeFakeHost() {
  const byName = new Map<string, SpriteState>();
  const byId = new Map<string, SpriteState>();
  const provisionCalls: string[] = [];
  const killCalls: string[] = [];
  let counter = 0;

  function makeHandle(state: SpriteState): MachineHandle {
    return {
      machineId: state.machineId,
      spriteInstanceId: `inst-${state.machineId}`,
      exec: async (args) => {
        state.execLog.push(args);
        if (args.cmd === 'mv' && args.args?.[0] !== undefined && args.args[1] !== undefined) {
          const [src, dst] = args.args;
          const content = state.files.get(src);
          if (content !== undefined) state.files.set(dst, content);
          state.files.delete(src);
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      writeFiles: async (files) => {
        for (const f of files) state.files.set(f.path, String(f.content));
      },
      readFile: async ({ path }) => {
        const content = state.files.get(path);
        return content === undefined ? null : Buffer.from(content);
      },
      createCheckpoint: async () => {},
      stream: async () => {
        throw new Error('not used by promotion');
      },
      listStreams: async () => [],
      killSession: async () => {},
    };
  }

  const host: MachineHost = {
    provision: async ({ name }) => {
      provisionCalls.push(name);
      let state = byName.get(name);
      if (!state) {
        counter += 1;
        state = { machineId: `sbx-project-${counter}`, execLog: [], files: new Map() };
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
  return { host, byId, provisionCalls, killCalls, makeHandle };
}

/**
 * The OWNING Machine's Sprite: `test -e` reports the checkout present, and
 * `git status --porcelain` reports it clean, unless a test says otherwise.
 */
function makeMachineSandbox({
  checkoutExists = true,
  status = { exitCode: 0, stdout: '', stderr: '' },
}: {
  checkoutExists?: boolean;
  /** One result for every `git status`, or a sequence consumed per call (last one repeats). */
  status?: SandboxRunResult | SandboxRunResult[];
} = {}) {
  const calls: RunCommandArgs[] = [];
  const statusQueue = Array.isArray(status) ? [...status] : [status];
  const sandbox: ExecutableSandbox = {
    sandboxId: MACHINE_SANDBOX_ID,
    spriteInstanceId: null,
    runCommand: async (opts) => {
      calls.push(opts);
      if (opts.cmd === 'test') return { exitCode: checkoutExists ? 0 : 1, stdout: '', stderr: '' };
      if (opts.cmd === 'git' || opts.args?.includes('status')) {
        return statusQueue.length > 1 ? statusQueue.shift()! : statusQueue[0];
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    writeFiles: async () => {},
    readFileToBuffer: async () => null,
    createCheckpoint: async () => {},
  };
  return { sandbox, calls };
}

function makeDeps(
  overrides: Partial<PromoteProjectDeps> = {},
  { seed, machine }: { seed?: MachineProjectRecord[]; machine?: ReturnType<typeof makeMachineSandbox> } = {},
) {
  const { store, rows, promoteCalls } = makeStore(seed);
  const { host, byId, provisionCalls, killCalls } = makeFakeHost();
  const machineSandbox = machine ?? makeMachineSandbox();
  const storageCalls: ProjectStorageMeasurement[] = [];

  const deps: PromoteProjectDeps = {
    store,
    isEnabled: () => true,
    now: () => NOW,
    host,
    substrate: { kind: 'sprite' },
    options: {},
    secret: SECRET,
    checkFullEgressEnablement: async () => ({ ok: true }),
    resolveGitHubToken: async () => 'ghp_secret_token',
    resolveRootMachineHandle: async () => null,
    acquireMachineSandbox: async () => ({ ok: true, sandboxId: MACHINE_SANDBOX_ID, resumed: false }),
    reconnect: async () => machineSandbox.sandbox,
    quota: { acquireSlot: () => true, releaseSlot: () => {} },
    buildEnv: () => ({ NODE_ENV: 'test' }),
    audit: async () => {},
    measureProjectStorage: async (input) => {
      storageCalls.push(input);
    },
    ...overrides,
  };
  return { deps, store, rows, promoteCalls, host, byId, provisionCalls, killCalls, machineSandbox, storageCalls };
}

const SESSION_KEY = deriveProjectSessionKey({
  tenantId: actor.tenantId,
  machineId: MACHINE_ID,
  projectName: PROJECT_NAME,
  secret: SECRET,
});

describe('deriveProjectSessionKey', () => {
  it('given the same tuple, should derive a stable key distinct from any branch/machine key', () => {
    const again = deriveProjectSessionKey({
      tenantId: actor.tenantId,
      machineId: MACHINE_ID,
      projectName: PROJECT_NAME,
      secret: SECRET,
    });
    expect(again).toBe(SESSION_KEY);
    expect(SESSION_KEY.startsWith('pgs-prj-')).toBe(true);
  });

  it('given two different projects on one machine, should derive two different keys', () => {
    const other = deriveProjectSessionKey({
      tenantId: actor.tenantId,
      machineId: MACHINE_ID,
      projectName: 'other-repo',
      secret: SECRET,
    });
    expect(other).not.toBe(SESSION_KEY);
  });
});

describe('promoteProject — first promotion', () => {
  it('given an unpromoted project, should provision under the project session key, clone to /workspace/repo, and CAS the row', async () => {
    const { deps, rows, provisionCalls, promoteCalls, byId } = makeDeps();

    const result = await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, deps });

    expect(result).toEqual({ ok: true, sandboxId: 'sbx-project-1', sessionKey: SESSION_KEY, promoted: true, resumed: false });
    expect(provisionCalls).toEqual([SESSION_KEY]);
    expect(promoteCalls).toEqual([{ id: PROJECT_ID, previousSandboxId: null, sandboxId: 'sbx-project-1' }]);

    const row = rows.get(PROJECT_ID);
    expect({ sandboxId: row?.sandboxId, sessionKey: row?.sessionKey, instance: row?.spriteInstanceId }).toEqual({
      sandboxId: 'sbx-project-1',
      sessionKey: SESSION_KEY,
      instance: 'inst-sbx-project-1',
    });

    // The clone ran on the PROJECT's own Sprite, into /workspace/repo.
    const cloned = byId.get('sbx-project-1')?.execLog.find((e) => e.args?.includes('clone'));
    expect(cloned?.args).toEqual(expect.arrayContaining([REPO_URL, PROJECT_REPO_PATH]));
  });

  it('given a root Sprite holding a Claude credential, should propagate it to the promoted Sprite', async () => {
    const { deps, host, byId } = makeDeps();
    const root = await host.provision({ name: 'root', substrate: { kind: 'sprite' }, options: {} });
    await root.writeFiles([{ path: '/home/sprite/.claude/.credentials.json', content: 'token-abc' }]);
    deps.resolveRootMachineHandle = async () => root;

    const result = await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, deps });
    expect(result.ok).toBe(true);

    const promotedState = result.ok ? byId.get(result.sandboxId) : undefined;
    expect(promotedState?.files.get('/home/sprite/.claude/.credentials.json')).toBe('token-abc');
  });

  it('given storage measurement, should attribute the promoted Sprite to the OWNING MACHINE page (phase 3 key)', async () => {
    const { deps, storageCalls } = makeDeps();

    await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, deps });

    expect(storageCalls.map((c) => ({ machineProjectId: c.machineProjectId, machinePageId: c.machinePageId }))).toEqual([
      { machineProjectId: PROJECT_ID, machinePageId: MACHINE_ID },
    ]);
  });

  it('given a project already promoted, should reattach without provisioning or re-cloning', async () => {
    // Pre-promote by hand so the row points at a live Sprite on the SAME host.
    const { host, provisionCalls } = makeDeps();
    const existing = await host.provision({ name: SESSION_KEY, substrate: { kind: 'sprite' }, options: {} });
    const seeded = makeDeps(
      { host },
      { seed: [makeRecord({ sessionKey: SESSION_KEY, sandboxId: existing.machineId, spriteInstanceId: existing.spriteInstanceId ?? null })] },
    );

    const result = await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, deps: seeded.deps });

    expect(result).toEqual({
      ok: true,
      sandboxId: existing.machineId,
      sessionKey: SESSION_KEY,
      promoted: false,
      resumed: true,
    });
    expect(seeded.promoteCalls).toEqual([]);
    // Only the manual pre-promotion above ever provisioned — the reattach did not.
    expect(provisionCalls).toEqual([SESSION_KEY]);
  });
});

describe('promoteProject — dirty-tree refusal', () => {
  it('given a dirty machine checkout, should REFUSE with an actionable error and provision nothing', async () => {
    const machine = makeMachineSandbox({ status: { exitCode: 0, stdout: ' M src/index.ts\n?? notes.md\n', stderr: '' } });
    const { deps, provisionCalls, rows } = makeDeps({}, { machine });

    const result = await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, deps });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('dirty_checkout');
    expect(result.detail).toContain(PROJECT_PATH);
    expect(result.detail).toContain('src/index.ts');
    expect(provisionCalls).toEqual([]);
    expect(rows.get(PROJECT_ID)?.sandboxId).toBeNull();
  });

  it('given an UNVERIFIABLE checkout (git status failed), should fail closed rather than risk losing work', async () => {
    const machine = makeMachineSandbox({ status: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } });
    const { deps, provisionCalls } = makeDeps({}, { machine });

    const result = await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, deps });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('dirty_check_failed');
    expect(provisionCalls).toEqual([]);
  });

  it('given NO machine-side checkout at all, should promote (nothing can be lost)', async () => {
    const machine = makeMachineSandbox({ checkoutExists: false });
    const { deps } = makeDeps({}, { machine });

    const result = await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, deps });

    expect(result.ok).toBe(true);
  });
});

describe('promoteProject — post-promotion checkout reclaim', () => {
  it('given a successful promotion, should remove the old PROJECTS_ROOT checkout from the machine Sprite', async () => {
    const { deps, machineSandbox } = makeDeps();

    await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, deps });

    expect(machineSandbox.calls.filter((c) => c.cmd === 'rm').map((c) => c.args)).toEqual([['-rf', PROJECT_PATH]]);
  });

  it('given a checkout that turned DIRTY while provisioning/cloning ran, should NOT reclaim it', async () => {
    // The dirty-tree check passes, then the user (or a terminal) writes into
    // the old checkout during the slow provision+clone. An unconditional rm at
    // the end would destroy that work — the reclaim re-checks cleanliness
    // immediately before deleting, and a leftover directory is an annoyance
    // where deleted work is a loss.
    const machine = makeMachineSandbox({
      status: [
        { exitCode: 0, stdout: '', stderr: '' }, // the gate: clean
        { exitCode: 0, stdout: '?? new-work.ts\n', stderr: '' }, // the recheck: dirty now
      ],
    });
    const { deps, machineSandbox } = makeDeps({}, { machine });

    const result = await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, deps });

    expect(result).toMatchObject({ ok: true, promoted: true });
    expect(machineSandbox.calls.filter((c) => c.cmd === 'rm')).toEqual([]);
  });

  it('given a refused promotion, should NOT touch the machine checkout', async () => {
    const machine = makeMachineSandbox({ status: { exitCode: 0, stdout: ' M src/index.ts\n', stderr: '' } });
    const { deps, machineSandbox } = makeDeps({}, { machine });

    await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, deps });

    expect(machineSandbox.calls.filter((c) => c.cmd === 'rm')).toEqual([]);
  });
});

describe('promoteProject — races and half-promotions', () => {
  it('given a CAS loss to a concurrent promotion that SHARES our Sprite, should reconcile to the winner and never kill it', async () => {
    const { deps, store, rows, killCalls } = makeDeps();
    // The racer wins between our clone and our CAS, recording the SAME Sprite
    // (provision is name-keyed, so both calls resolved to it).
    const realPromote = store.promote;
    let first = true;
    store.promote = async (input) => {
      if (first) {
        first = false;
        const row = rows.get(input.id);
        if (row) rows.set(input.id, { ...row, sessionKey: input.sessionKey, sandboxId: input.sandboxId, spriteInstanceId: input.spriteInstanceId });
        return false; // our CAS lost
      }
      return realPromote(input);
    };

    const result = await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, deps });

    expect(result).toEqual({
      ok: true,
      sandboxId: 'sbx-project-1',
      sessionKey: SESSION_KEY,
      promoted: false,
      resumed: true,
    });
    expect(killCalls).toEqual([]);
  });

  it('given a CAS loss to a winner holding the SAME NAME but a DIFFERENT INSTANCE, should still tear ours down', async () => {
    // A name is reused across re-creates: two concurrent provisions can hold
    // two different VMs answering to one sandboxId. Comparing the name alone
    // would skip the kill and leave the losing INSTANCE alive, untracked, and
    // billing. The kill is identity-guarded, so if the instances turn out to
    // be the same VM after all, the guard makes the extra attempt a no-op.
    const { deps, store, rows, killCalls } = makeDeps();
    store.promote = async (input) => {
      const row = rows.get(input.id);
      // Winner recorded the SAME Sprite NAME with a DIFFERENT instance id.
      if (row) rows.set(input.id, { ...row, sessionKey: SESSION_KEY, sandboxId: input.sandboxId, spriteInstanceId: 'inst-other-generation' });
      return false;
    };

    const result = await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, deps });

    expect(result).toMatchObject({ ok: true, promoted: false, resumed: true });
    expect(killCalls).toEqual(['sbx-project-1']);
  });

  it('given a CAS loss to a winner on a DIFFERENT Sprite, should tear down our redundant Sprite', async () => {
    const { deps, store, rows, killCalls } = makeDeps();
    store.promote = async (input) => {
      const row = rows.get(input.id);
      if (row) rows.set(input.id, { ...row, sessionKey: SESSION_KEY, sandboxId: 'sbx-winner', spriteInstanceId: 'inst-winner' });
      return false;
    };

    const result = await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, deps });

    expect(result).toEqual({ ok: true, sandboxId: 'sbx-winner', sessionKey: SESSION_KEY, promoted: false, resumed: true });
    expect(killCalls).toEqual(['sbx-project-1']);
  });

  it('given the persist THROWING (a half-promotion), should kill the unrecorded Sprite and let a retry re-promote cleanly', async () => {
    const { deps, store, killCalls, provisionCalls, rows } = makeDeps();
    const realPromote = store.promote;
    let failed = false;
    store.promote = async (input) => {
      if (!failed) {
        failed = true;
        throw new Error('connection terminated');
      }
      return realPromote(input);
    };

    const first = await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, deps });
    expect(first.ok).toBe(false);
    // No orphan: the Sprite nothing points at was destroyed.
    expect(killCalls).toEqual(['sbx-project-1']);
    expect(rows.get(PROJECT_ID)?.sandboxId).toBeNull();

    const second = await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, deps });
    expect(second.ok).toBe(true);
    // Re-derived the SAME deterministic session key both times.
    expect(provisionCalls).toEqual([SESSION_KEY, SESSION_KEY]);
  });

  it('given a promoted project whose Sprite VANISHED, should re-provision under the same session key and CAS off the old sandboxId', async () => {
    const { deps, promoteCalls, provisionCalls } = makeDeps({}, {
      seed: [makeRecord({ sessionKey: SESSION_KEY, sandboxId: 'sbx-gone', spriteInstanceId: 'inst-gone' })],
    });

    const result = await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, deps });

    expect(result.ok).toBe(true);
    expect(provisionCalls).toEqual([SESSION_KEY]);
    expect(promoteCalls).toEqual([{ id: PROJECT_ID, previousSandboxId: 'sbx-gone', sandboxId: 'sbx-project-1' }]);
  });
});

describe('promoteProject — gates', () => {
  it('given the kill switch off, should deny before any lookup', async () => {
    const { deps } = makeDeps({ isEnabled: () => false });
    expect(await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, deps })).toEqual({
      ok: false,
      reason: 'kill_switch_off',
    });
  });

  it('given an unknown project, should deny project_not_found', async () => {
    const { deps } = makeDeps({}, { seed: [] });
    expect(await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, deps })).toEqual({
      ok: false,
      reason: 'project_not_found',
    });
  });

  it('given full egress not enabled, should deny before provisioning', async () => {
    const { deps, provisionCalls } = makeDeps({
      checkFullEgressEnablement: async () => ({ ok: false, reason: 'containment_unverified' }),
    });
    const result = await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, deps });
    expect(result.ok).toBe(false);
    expect(provisionCalls).toEqual([]);
  });

  it('given a failed clone, should kill the provisioned Sprite and leave the row unpromoted', async () => {
    const { deps, killCalls, rows } = makeDeps({ resolveGitHubToken: async () => null });
    // Force the clone to fail by making the project handle's exec report failure.
    const host = deps.host;
    deps.host = {
      ...host,
      provision: async (args) => {
        const handle = await host.provision(args);
        return { ...handle, exec: async () => ({ exitCode: 1, stdout: '', stderr: 'fatal: repository not found' }) };
      },
    };

    const result = await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, deps });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('clone_failed');
    expect(killCalls).toEqual(['sbx-project-1']);
    expect(rows.get(PROJECT_ID)?.sandboxId).toBeNull();
  });
});

describe('isPromotedProject', () => {
  it('given a row with a live sandbox, should be promoted; a torn-down or absent one should not', () => {
    expect(isPromotedProject({ sandboxId: 'sbx-1', spriteTornDownAt: null })).toBe(true);
    expect(isPromotedProject({ sandboxId: 'sbx-1', spriteTornDownAt: NOW })).toBe(false);
    expect(isPromotedProject({ sandboxId: null, spriteTornDownAt: null })).toBe(false);
  });
});
