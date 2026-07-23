import { describe, it, expect } from 'vitest';
import {
  promoteProject,
  isPromotedProject,
  PROJECT_REPO_PATH,
  classifyCheckoutStatus,
  isCloneBlockedByExistingCheckout,
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

/** `git status --porcelain -b` output for a checkout that is clean AND fully pushed. */
const CLEAN_STATUS = '## main...origin/main\n';

/**
 * The OWNING Machine's Sprite: `test -e` reports the checkout present, and
 * `git status --porcelain -b` reports it clean and pushed, unless a test says
 * otherwise. The branch header is part of the fixture because it is part of the
 * command — a clean tree alone no longer licenses promotion (F1).
 */
function makeMachineSandbox({
  checkoutExists = true,
  status = { exitCode: 0, stdout: CLEAN_STATUS, stderr: '' },
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
    const machine = makeMachineSandbox({ status: { exitCode: 0, stdout: `${CLEAN_STATUS} M src/index.ts\n?? notes.md\n`, stderr: '' } });
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
        { exitCode: 0, stdout: CLEAN_STATUS, stderr: '' }, // the gate: clean
        { exitCode: 0, stdout: `${CLEAN_STATUS}?? new-work.ts\n`, stderr: '' }, // the recheck: dirty now
      ],
    });
    const { deps, machineSandbox } = makeDeps({}, { machine });

    const result = await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, deps });

    expect(result).toMatchObject({ ok: true, promoted: true });
    expect(machineSandbox.calls.filter((c) => c.cmd === 'rm')).toEqual([]);
  });

  it('given a refused promotion, should NOT touch the machine checkout', async () => {
    const machine = makeMachineSandbox({ status: { exitCode: 0, stdout: `${CLEAN_STATUS} M src/index.ts\n`, stderr: '' } });
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

/**
 * Issue #2204 follow-up, F1. `git status --porcelain` reports a checkout with
 * unpushed commits as pristine, so promotion deleted the only copy of that work
 * on its way to a fresh clone. Cleanliness was never the right question —
 * REPRODUCIBILITY FROM THE REMOTE is.
 */
describe('classifyCheckoutStatus', () => {
  it('given a clean tree tracking an upstream, should report clean', () => {
    expect(classifyCheckoutStatus('## main...origin/main\n')).toEqual({ kind: 'clean' });
  });

  it('given working-tree changes, should report dirty with just the changes', () => {
    expect(classifyCheckoutStatus('## main...origin/main\n M src/a.ts\n?? b.md\n')).toEqual({
      kind: 'dirty',
      detail: ' M src/a.ts\n?? b.md',
    });
  });

  it('given a CLEAN tree that is ahead of its upstream, should refuse as unpushed', () => {
    const result = classifyCheckoutStatus('## main...origin/main [ahead 2]\n');
    expect(result.kind).toBe('unpushed');
    expect(result.kind === 'unpushed' && result.detail).toContain('2 commit(s)');
  });

  it('given a branch both ahead AND behind, should still refuse — the ahead commits are the loss', () => {
    expect(classifyCheckoutStatus('## main...origin/main [ahead 1, behind 3]\n').kind).toBe('unpushed');
  });

  it('given a branch merely BEHIND its upstream, should report clean — nothing local is at risk', () => {
    expect(classifyCheckoutStatus('## main...origin/main [behind 3]\n')).toEqual({ kind: 'clean' });
  });

  it('given a branch with NO upstream, should refuse — there is no remote ref to reproduce it from', () => {
    const result = classifyCheckoutStatus('## scratch\n');
    expect(result.kind).toBe('unpushed');
    expect(result.kind === 'unpushed' && result.detail).toContain('no upstream');
  });

  it('given a detached HEAD, should refuse for the same reason', () => {
    expect(classifyCheckoutStatus('## HEAD (no branch)\n').kind).toBe('unpushed');
  });

  it('given dirty changes AND unpushed commits, should report dirty — the nearer, more actionable fix', () => {
    expect(classifyCheckoutStatus('## main...origin/main [ahead 1]\n M a.ts\n').kind).toBe('dirty');
  });

  it('given output with NO branch header, should be unknown rather than assumed clean', () => {
    // `-b` always emits one, so its absence means we are not reading what we think.
    expect(classifyCheckoutStatus('').kind).toBe('unknown');
  });
});

/**
 * Issue #2204 follow-up, F2. Two promotions of one project derive the same
 * deterministic session key, so a name-keyed provision can hand both racers the
 * SAME physical Sprite — and the loser's clone fails precisely because the
 * winner already populated the destination.
 */
describe('isCloneBlockedByExistingCheckout', () => {
  it('given git\'s "already exists and is not an empty directory", should recognise a shared Sprite', () => {
    expect(
      isCloneBlockedByExistingCheckout(
        "fatal: destination path '/workspace/repo' already exists and is not an empty directory.",
      ),
    ).toBe(true);
  });

  it('given an authentication failure, should NOT — that Sprite is ours alone and must be torn down', () => {
    expect(isCloneBlockedByExistingCheckout('fatal: Authentication failed for https://github.com/o/r.git')).toBe(false);
  });

  it('given a missing repository, should NOT', () => {
    expect(isCloneBlockedByExistingCheckout('fatal: repository not found')).toBe(false);
  });

  it('given empty output, should NOT — an unexplained failure is not evidence of a racer', () => {
    expect(isCloneBlockedByExistingCheckout('')).toBe(false);
  });
});

describe('promoteProject — unpushed-commit refusal (F1)', () => {
  it('given a clean checkout holding unpushed commits, should REFUSE and provision nothing', async () => {
    const machine = makeMachineSandbox({
      status: { exitCode: 0, stdout: '## main...origin/main [ahead 2]\n', stderr: '' },
    });
    const { deps, provisionCalls } = makeDeps({}, { machine });

    const result = await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, deps });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unpushed_commits');
    expect(result.detail).toContain('push');
    expect(provisionCalls).toEqual([]);
  });
});

describe('promoteProject — shared-Sprite protection on clone failure (F2)', () => {
  it('given a clone blocked by an existing checkout, should NOT kill the Sprite a racer may be promoting on', async () => {
    const { deps, killCalls } = makeDeps({}, {});
    const blocked: PromoteProjectDeps = {
      ...deps,
      host: {
        ...deps.host,
        provision: async (args) => {
          const handle = await deps.host.provision(args);
          return {
            ...handle,
            exec: async () => ({
              exitCode: 128,
              stdout: '',
              stderr: "fatal: destination path '/workspace/repo' already exists and is not an empty directory.",
            }),
          };
        },
      },
    };

    const result = await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, deps: blocked });

    expect(result.ok).toBe(false);
    expect(killCalls).toEqual([]);
  });

  it('given a clone that failed for our OWN reason, should still tear the unrecorded Sprite down', async () => {
    const { deps, killCalls } = makeDeps({}, {});
    const failing: PromoteProjectDeps = {
      ...deps,
      host: {
        ...deps.host,
        provision: async (args) => {
          const handle = await deps.host.provision(args);
          return {
            ...handle,
            exec: async () => ({ exitCode: 128, stdout: '', stderr: 'fatal: repository not found' }),
          };
        },
      },
    };

    const result = await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, deps: failing });

    expect(result.ok).toBe(false);
    expect(killCalls.length).toBe(1);
  });
});

describe('promoteProject — root re-measurement after reclaim (F12)', () => {
  it('given a successful reclaim, should refresh the ROOT measurement so the removed bytes stop being billed', async () => {
    const remeasured: string[] = [];
    const { deps } = makeDeps({
      remeasureMachineStorage: async ({ machinePageId }) => {
        remeasured.push(machinePageId);
      },
    });

    const result = await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, deps });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.ok).toBe(true);
    expect(remeasured).toEqual([MACHINE_ID]);
  });

  it('given a checkout that was ABSENT, should not re-measure — nothing was removed', async () => {
    const remeasured: string[] = [];
    const machine = makeMachineSandbox({ checkoutExists: false });
    const { deps } = makeDeps(
      {
        remeasureMachineStorage: async ({ machinePageId }) => {
          remeasured.push(machinePageId);
        },
      },
      { machine },
    );

    await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, deps });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(remeasured).toEqual([]);
  });
});

/**
 * ReDoS regressions (CodeQL alerts 267/268 on PR #2209). Both inputs are
 * attacker-influencable — a branch NAME reaches the porcelain header, and a
 * repo URL/path reaches git's stderr — so neither classifier may scan with a
 * backtracking `.*`.
 */
describe('checkout classifiers — linear on hostile input', () => {
  it('given a branch name full of [, should classify without superlinear scanning', () => {
    const hostile = `## ${'['.repeat(20000)}...origin/main\n`;
    const startedAt = Date.now();
    const result = classifyCheckoutStatus(hostile);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    // No `]`, so no divergence payload and no upstream marker it can trust.
    expect(result.kind).toBe('clean');
  });

  it('given a bracket-heavy branch name that IS ahead, should still find the divergence', () => {
    const result = classifyCheckoutStatus('## we[i]rd[[[...origin/weird [ahead 3]\n');
    expect(result.kind).toBe('unpushed');
    expect(result.kind === 'unpushed' && result.detail).toContain('3 commit(s)');
  });

  it('given clone output repeating "destination path", should test without superlinear scanning', () => {
    const hostile = `${'destination path '.repeat(20000)}fatal: nope`;
    const startedAt = Date.now();
    const result = isCloneBlockedByExistingCheckout(hostile);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(result).toBe(false);
  });

  it('given mixed-case git output, should still recognise the shared-Sprite signal', () => {
    expect(isCloneBlockedByExistingCheckout("fatal: destination path 'X' ALREADY EXISTS.")).toBe(true);
  });
});
