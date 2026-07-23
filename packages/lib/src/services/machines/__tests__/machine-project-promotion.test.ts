import { describe, it, expect } from 'vitest';
import {
  promoteProject,
  isPromotedProject,
  PROJECT_REPO_PATH,
  classifyCheckoutStatus,
  isCloneBlockedByExistingCheckout,
  parseCheckoutBranchName,
  isCarryableState,
  buildCarryPlan,
  parseFileSizeBytes,
  isReclaimableAfterCarry,
  MAX_CARRY_BUNDLE_BYTES,
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
        // Binary-faithful: the carry transfers a bundle as bytes, and a
        // `String(Uint8Array)` here would quietly turn it into "66,85,78,…"
        // and hide a real corruption bug behind a passing test.
        for (const f of files) {
          state.files.set(f.path, typeof f.content === 'string' ? f.content : Buffer.from(f.content).toString('utf8'));
        }
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
 * The git SUBCOMMAND of an invocation, skipping any leading `-c key=value`
 * pairs — `['-c','user.name=x','commit','-m','…']` is a `commit`.
 */
function gitSubcommand(args: string[] | undefined): string | null {
  if (!args) return null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-c') {
      i += 1;
      continue;
    }
    if (!args[i].startsWith('-')) return args[i];
  }
  return null;
}

const CARRY_SHA = 'c0ffee1234567890';

/**
 * The OWNING Machine's Sprite: `test -e` reports the checkout present, and
 * `git status --porcelain -b` reports it clean and pushed, unless a test says
 * otherwise. The branch header is part of the fixture because it is part of the
 * command — a clean tree alone no longer licenses promotion (F1).
 *
 * The carry path (#2207) drives more than `status` here — `add`, `commit`,
 * `rev-parse`, `bundle`, a `stat` size probe and a binary read of the bundle —
 * so every one of those is routable per test.
 */
function makeMachineSandbox({
  checkoutExists = true,
  status = { exitCode: 0, stdout: CLEAN_STATUS, stderr: '' },
  git = {},
  bundleBytes = 4096,
  bundleContent = 'BUNDLE-BYTES' as string | null,
  statResult,
}: {
  checkoutExists?: boolean;
  /** One result for every `git status`, or a sequence consumed per call (last one repeats). */
  status?: SandboxRunResult | SandboxRunResult[];
  /** Per-subcommand overrides for every git call that is NOT `status`. */
  git?: Record<string, SandboxRunResult>;
  bundleBytes?: number;
  /** `null` makes the bundle unreadable — the transfer-failure case. */
  bundleContent?: string | null;
  statResult?: SandboxRunResult;
} = {}) {
  const calls: RunCommandArgs[] = [];
  const statusQueue = Array.isArray(status) ? [...status] : [status];
  const sandbox: ExecutableSandbox = {
    sandboxId: MACHINE_SANDBOX_ID,
    spriteInstanceId: null,
    runCommand: async (opts) => {
      calls.push(opts);
      if (opts.cmd === 'test') return { exitCode: checkoutExists ? 0 : 1, stdout: '', stderr: '' };
      if (opts.cmd === 'stat') return statResult ?? { exitCode: 0, stdout: `${bundleBytes}\n`, stderr: '' };
      if (opts.cmd === 'git') {
        const sub = gitSubcommand(opts.args);
        if (sub === 'status') return statusQueue.length > 1 ? statusQueue.shift()! : statusQueue[0];
        if (sub && git[sub]) return git[sub];
        if (sub === 'rev-parse') return { exitCode: 0, stdout: `${CARRY_SHA}\n`, stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    writeFiles: async () => {},
    readFileToBuffer: async () => (bundleContent === null ? null : Buffer.from(bundleContent)),
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
    // No real clock in tests: the promotion-race poll resolves immediately.
    wait: async () => {},
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

    expect(result).toEqual({ ok: true, sandboxId: 'sbx-project-1', sessionKey: SESSION_KEY, promoted: true, resumed: false, carried: false });
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
      carried: false,
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
      carried: false,
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

    expect(result).toEqual({ ok: true, sandboxId: 'sbx-winner', sessionKey: SESSION_KEY, promoted: false, resumed: true, carried: false });
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

  it('given a DELETED upstream ([gone]), should refuse — nothing on the remote can reproduce this branch', () => {
    // Git reports no ahead/behind counts for a gone upstream, so the `...` in
    // the header would otherwise read as tracked-and-in-sync.
    const result = classifyCheckoutStatus('## main...origin/main [gone]\n');
    expect(result.kind).toBe('unpushed');
    expect(result.kind === 'unpushed' && result.detail).toContain('no longer exists');
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
  it('given a clone blocked by a checkout a racer is promoting into, should adopt the winner and NOT kill the shared Sprite', async () => {
    const { deps, killCalls, rows } = makeDeps({}, {});
    let polls = 0;
    const blocked: PromoteProjectDeps = {
      ...deps,
      store: {
        ...deps.store,
        // The winner's CAS lands while we are waiting, exactly as a real racer's would.
        findById: async (id) => {
          polls += 1;
          if (polls > 1) {
            const row = rows.get(id)!;
            row.sandboxId = 'sbx-winner';
            row.sessionKey = 'winner-key';
          }
          return rows.get(id) ?? null;
        },
      },
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

    expect(result).toMatchObject({ ok: true, sandboxId: 'sbx-winner', promoted: false, resumed: true });
    expect(killCalls).toEqual([]);
  });

  it('given a populated destination but NO winner ever appearing, should reclaim the derelict Sprite rather than leak it', async () => {
    // A previous promotion whose persist failed and whose best-effort kill also
    // failed leaves the same populated Sprite behind with the row unpromoted.
    // Trusting git's message alone would make every retry resume it, fail the
    // same clone, and leave it billing forever.
    const { deps, killCalls } = makeDeps({}, {});
    const derelict: PromoteProjectDeps = {
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

    const result = await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, deps: derelict });

    expect(result).toMatchObject({ ok: false, reason: 'clone_failed' });
    expect(killCalls.length).toBe(1);
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

/**
 * Issue #2207 — the DIRTY-CHECKOUT MIGRATION PATH.
 *
 * The refusal that makes promotion safe used to be a dead end: the only way past
 * it was to go and commit/push by hand on the machine Sprite. `carryDirty` is
 * the opt-in that carries the work across instead — as a git BUNDLE, moved as
 * bytes, so nothing about the transfer can silently corrupt it.
 */
describe('parseCheckoutBranchName', () => {
  it('given a tracked branch, should take the local name only', () => {
    expect(parseCheckoutBranchName('## main...origin/main [ahead 2]\n')).toBe('main');
  });

  it('given a branch with NO upstream, should still name it', () => {
    expect(parseCheckoutBranchName('## scratch\n')).toBe('scratch');
  });

  it('given a detached HEAD, should report no branch', () => {
    expect(parseCheckoutBranchName('## HEAD (no branch)\n')).toBeNull();
  });

  it('given an unborn branch on a fresh repo, should name it', () => {
    expect(parseCheckoutBranchName('## No commits yet on main\n')).toBe('main');
  });

  it('given no branch header at all, should report no branch', () => {
    expect(parseCheckoutBranchName(' M a.ts\n')).toBeNull();
  });

  it('given an empty header, should report no branch rather than an empty name', () => {
    expect(parseCheckoutBranchName('## \n')).toBeNull();
  });
});

describe('isCarryableState', () => {
  it('given work a clone cannot reproduce, should be carryable', () => {
    expect(isCarryableState({ kind: 'dirty', detail: ' M a.ts' })).toBe(true);
    expect(isCarryableState({ kind: 'unpushed', detail: '2 commit(s)' })).toBe(true);
  });

  it('given nothing at risk, should not be — there is nothing to carry', () => {
    expect(isCarryableState({ kind: 'clean' })).toBe(false);
    expect(isCarryableState({ kind: 'absent' })).toBe(false);
  });

  it('given an UNVERIFIABLE checkout, should NOT be carryable — we cannot bundle what we cannot read', () => {
    expect(isCarryableState({ kind: 'unknown', detail: 'git status did not complete' })).toBe(false);
  });
});

describe('buildCarryPlan', () => {
  it('given a DIRTY checkout on a named branch, should commit, bundle, and reset the carry commit away', () => {
    const plan = buildCarryPlan({ state: { kind: 'dirty', detail: ' M a.ts' }, branchName: 'main', projectId: PROJECT_ID });
    expect(plan).toEqual({
      needsCommit: true,
      needsBranchCreate: false,
      needsReset: true,
      branch: 'main',
      bundlePath: '/home/sprite/pagespace-carry-p1.bundle',
      fetchRefspec: '+refs/heads/*:refs/remotes/pagespace-carry/*',
      checkoutTarget: 'pagespace-carry/main',
    });
  });

  it('given an UNPUSHED-only checkout, should bundle WITHOUT committing — and therefore without resetting', () => {
    // A clean tree has nothing to commit, and an empty carry commit would make
    // the `reset --mixed HEAD~1` on the far side throw away a real commit.
    const plan = buildCarryPlan({ state: { kind: 'unpushed', detail: '2 commit(s)' }, branchName: 'feature', projectId: PROJECT_ID });
    expect(plan.needsCommit).toBe(false);
    expect(plan.needsReset).toBe(false);
    expect(plan.checkoutTarget).toBe('pagespace-carry/feature');
  });

  it('given a DETACHED HEAD, should create a named ref first — `bundle --all` can only carry refs', () => {
    const plan = buildCarryPlan({ state: { kind: 'dirty', detail: ' M a.ts' }, branchName: null, projectId: PROJECT_ID });
    expect(plan.needsBranchCreate).toBe(true);
    expect(plan.branch).toBe('pagespace-carry');
    expect(plan.checkoutTarget).toBe('pagespace-carry/pagespace-carry');
  });

  it('given a project id with path-hostile characters, should keep the bundle path a single tame filename', () => {
    const plan = buildCarryPlan({ state: { kind: 'clean' }, branchName: 'main', projectId: '../../etc/pas swd' });
    expect(plan.bundlePath).toBe('/home/sprite/pagespace-carry-etcpasswd.bundle');
  });
});

describe('parseFileSizeBytes', () => {
  it('given stat output, should read the byte count', () => {
    expect(parseFileSizeBytes('4096\n')).toBe(4096);
  });

  it('given zero, should read zero rather than falsy-collapse to null', () => {
    expect(parseFileSizeBytes('0')).toBe(0);
  });

  it('given anything that is not a plain integer, should report unknown so the caller fails closed', () => {
    expect(parseFileSizeBytes('')).toBeNull();
    expect(parseFileSizeBytes('stat: cannot stat')).toBeNull();
    expect(parseFileSizeBytes('12x')).toBeNull();
  });
});

describe('isReclaimableAfterCarry', () => {
  const carrySha = 'abc123';

  it('given a tree that is exactly the carry commit we made, should reclaim', () => {
    // The carry left the machine tree clean but one commit ahead, so the
    // ordinary `clean` recheck would refuse and leak the old checkout forever.
    expect(isReclaimableAfterCarry({ recheckKind: 'unpushed', headSha: carrySha, carrySha })).toBe(true);
    expect(isReclaimableAfterCarry({ recheckKind: 'clean', headSha: carrySha, carrySha })).toBe(true);
  });

  it('given NEW work written during the promotion, should refuse — deleting it is the unrecoverable mistake', () => {
    expect(isReclaimableAfterCarry({ recheckKind: 'dirty', headSha: carrySha, carrySha })).toBe(false);
    expect(isReclaimableAfterCarry({ recheckKind: 'unknown', headSha: carrySha, carrySha })).toBe(false);
    expect(isReclaimableAfterCarry({ recheckKind: 'absent', headSha: carrySha, carrySha })).toBe(false);
  });

  it('given a HEAD that moved past the carry commit, should refuse', () => {
    expect(isReclaimableAfterCarry({ recheckKind: 'unpushed', headSha: 'def456', carrySha })).toBe(false);
  });

  it('given an unreadable sha on either side, should refuse', () => {
    expect(isReclaimableAfterCarry({ recheckKind: 'clean', headSha: null, carrySha })).toBe(false);
    expect(isReclaimableAfterCarry({ recheckKind: 'clean', headSha: carrySha, carrySha: null })).toBe(false);
  });
});

describe('promoteProject — carryDirty opt-in (#2207)', () => {
  const DIRTY_STATUS = `${CLEAN_STATUS} M src/index.ts\n?? notes.md\n`;
  /** What the machine checkout looks like AFTER the carry commit: clean, one ahead. */
  const CARRIED_STATUS = '## main...origin/main [ahead 1]\n';

  it('given carryDirty NOT set, should still refuse a dirty checkout and point at the way out', async () => {
    const machine = makeMachineSandbox({ status: { exitCode: 0, stdout: DIRTY_STATUS, stderr: '' } });
    const { deps, provisionCalls } = makeDeps({}, { machine });

    const result = await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, deps });

    expect(result).toMatchObject({ ok: false, reason: 'dirty_checkout' });
    expect(result.ok === false && result.detail).toContain('carryDirty');
    expect(provisionCalls).toEqual([]);
  });

  it('given carryDirty and a DIRTY checkout, should commit + bundle on the machine, transfer the bytes, and restore the work on the new Sprite', async () => {
    const machine = makeMachineSandbox({
      status: [
        { exitCode: 0, stdout: DIRTY_STATUS, stderr: '' }, // the gate
        { exitCode: 0, stdout: CARRIED_STATUS, stderr: '' }, // the pre-reclaim recheck
      ],
    });
    const { deps, byId, rows, machineSandbox } = makeDeps({}, { machine });

    const result = await promoteProject({
      machineId: MACHINE_ID,
      projectName: PROJECT_NAME,
      actor,
      carryDirty: true,
      deps,
    });

    expect(result).toMatchObject({ ok: true, promoted: true, carried: true });
    expect(rows.get(PROJECT_ID)?.sandboxId).toBe('sbx-project-1');

    // MACHINE side: everything in the tree became one commit, then a bundle.
    const machineGit = machineSandbox.calls.filter((c) => c.cmd === 'git').map((c) => gitSubcommand(c.args));
    expect(machineGit).toEqual(expect.arrayContaining(['add', 'commit', 'rev-parse', 'bundle']));

    // TRANSFER: the bundle landed on the project Sprite as bytes.
    const projectState = byId.get('sbx-project-1');
    expect(projectState?.files.get('/home/sprite/pagespace-carry-p1.bundle')).toBe('BUNDLE-BYTES');

    // PROJECT side: fetched from the bundle, checked the branch out, then put
    // the carried work back in the working tree as uncommitted changes.
    const projectGit = projectState?.execLog.filter((e) => e.cmd === 'git').map((e) => gitSubcommand(e.args));
    expect(projectGit).toEqual(['clone', 'fetch', 'checkout', 'reset']);
    const reset = projectState?.execLog.find((e) => gitSubcommand(e.args) === 'reset');
    expect(reset?.args).toEqual(['reset', '--mixed', 'HEAD~1']);
  });

  it('given carryDirty and an UNPUSHED-only checkout, should carry the commits without inventing one', async () => {
    const machine = makeMachineSandbox({ status: { exitCode: 0, stdout: '## main...origin/main [ahead 2]\n', stderr: '' } });
    const { deps, byId, machineSandbox } = makeDeps({}, { machine });

    const result = await promoteProject({
      machineId: MACHINE_ID,
      projectName: PROJECT_NAME,
      actor,
      carryDirty: true,
      deps,
    });

    expect(result).toMatchObject({ ok: true, carried: true });
    const machineGit = machineSandbox.calls.filter((c) => c.cmd === 'git').map((c) => gitSubcommand(c.args));
    expect(machineGit).not.toContain('commit');
    expect(machineGit).toContain('bundle');
    const projectGit = byId.get('sbx-project-1')?.execLog.filter((e) => e.cmd === 'git').map((e) => gitSubcommand(e.args));
    expect(projectGit).toEqual(['clone', 'fetch', 'checkout']);
  });

  it('given carryDirty on a CLEAN checkout, should carry nothing and behave exactly as before', async () => {
    const { deps, machineSandbox } = makeDeps();

    const result = await promoteProject({
      machineId: MACHINE_ID,
      projectName: PROJECT_NAME,
      actor,
      carryDirty: true,
      deps,
    });

    expect(result).toMatchObject({ ok: true, carried: false });
    expect(machineSandbox.calls.filter((c) => c.cmd === 'git').map((c) => gitSubcommand(c.args))).toEqual(['status', 'status']);
  });

  it('given an UNVERIFIABLE checkout, should refuse even WITH carryDirty', async () => {
    const machine = makeMachineSandbox({ status: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } });
    const { deps, provisionCalls } = makeDeps({}, { machine });

    const result = await promoteProject({
      machineId: MACHINE_ID,
      projectName: PROJECT_NAME,
      actor,
      carryDirty: true,
      deps,
    });

    expect(result).toMatchObject({ ok: false, reason: 'dirty_check_failed' });
    expect(provisionCalls).toEqual([]);
  });
});

describe('promoteProject — carry failures leave nothing behind (#2207)', () => {
  const DIRTY = { exitCode: 0, stdout: `${CLEAN_STATUS} M src/index.ts\n`, stderr: '' };

  async function promoteWithCarry(deps: PromoteProjectDeps) {
    return promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, carryDirty: true, deps });
  }

  it('given the bundle failing to build, should kill the provisioned Sprite and leave the row unpromoted', async () => {
    const machine = makeMachineSandbox({ status: DIRTY, git: { bundle: { exitCode: 128, stdout: '', stderr: 'fatal: refusing to create empty bundle' } } });
    const { deps, killCalls, rows } = makeDeps({}, { machine });

    const result = await promoteWithCarry(deps);

    expect(result).toMatchObject({ ok: false, reason: 'carry_failed' });
    expect(result.ok === false && result.detail).toContain('empty bundle');
    expect(killCalls).toEqual(['sbx-project-1']);
    expect(rows.get(PROJECT_ID)?.sandboxId).toBeNull();
  });

  it('given a bundle that cannot be read back, should fail the carry rather than promote without the work', async () => {
    const machine = makeMachineSandbox({ status: DIRTY, bundleContent: null });
    const { deps, killCalls, rows } = makeDeps({}, { machine });

    expect(await promoteWithCarry(deps)).toMatchObject({ ok: false, reason: 'carry_failed' });
    expect(killCalls).toEqual(['sbx-project-1']);
    expect(rows.get(PROJECT_ID)?.sandboxId).toBeNull();
  });

  it('given an unreadable bundle SIZE, should fail closed — an unbounded read is an OOM', async () => {
    const machine = makeMachineSandbox({ status: DIRTY, statResult: { exitCode: 1, stdout: '', stderr: 'stat: cannot stat' } });
    const { deps } = makeDeps({}, { machine });

    expect(await promoteWithCarry(deps)).toMatchObject({ ok: false, reason: 'carry_failed' });
  });

  it('given a bundle larger than the cap, should refuse with its own actionable reason', async () => {
    const machine = makeMachineSandbox({ status: DIRTY, bundleBytes: MAX_CARRY_BUNDLE_BYTES + 1 });
    const { deps, killCalls } = makeDeps({}, { machine });

    const result = await promoteWithCarry(deps);

    expect(result).toMatchObject({ ok: false, reason: 'carry_too_large' });
    expect(killCalls).toEqual(['sbx-project-1']);
  });

  it('given the far-side fetch failing, should fail the carry — a promoted project missing the work is the loss we refuse', async () => {
    const machine = makeMachineSandbox({ status: DIRTY });
    const { deps, killCalls, rows } = makeDeps({}, { machine });
    const host = deps.host;
    deps.host = {
      ...host,
      provision: async (args) => {
        const handle = await host.provision(args);
        return {
          ...handle,
          exec: async (e) =>
            gitSubcommand(e.args) === 'fetch'
              ? { exitCode: 128, stdout: '', stderr: 'fatal: bundle is corrupt' }
              : handle.exec(e),
        };
      },
    };

    const result = await promoteWithCarry(deps);

    expect(result).toMatchObject({ ok: false, reason: 'carry_failed' });
    expect(killCalls).toEqual(['sbx-project-1']);
    expect(rows.get(PROJECT_ID)?.sandboxId).toBeNull();
  });
});

describe('promoteProject — reclaim after a carry (#2207)', () => {
  const DIRTY = { exitCode: 0, stdout: `${CLEAN_STATUS} M src/index.ts\n`, stderr: '' };

  it('given the machine tree left exactly at our carry commit, should reclaim the old checkout', async () => {
    const machine = makeMachineSandbox({
      status: [DIRTY, { exitCode: 0, stdout: '## main...origin/main [ahead 1]\n', stderr: '' }],
    });
    const { deps, machineSandbox } = makeDeps({}, { machine });

    await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, carryDirty: true, deps });

    // The CHECKOUT reclaim is the `-rf`; the carry's own `rm -f` of the staged
    // bundle is housekeeping, not the reclaim under test.
    expect(machineSandbox.calls.filter((c) => c.args?.[0] === '-rf').map((c) => c.args)).toEqual([['-rf', PROJECT_PATH]]);
  });

  it('given someone committing on the machine DURING the promotion, should not reclaim', async () => {
    let revParseCalls = 0;
    const machine = makeMachineSandbox({
      status: [DIRTY, { exitCode: 0, stdout: '## main...origin/main [ahead 2]\n', stderr: '' }],
    });
    const inner = machine.sandbox.runCommand;
    machine.sandbox.runCommand = async (opts) => {
      if (opts.cmd === 'git' && gitSubcommand(opts.args) === 'rev-parse') {
        revParseCalls += 1;
        // The carry's own read, then a DIFFERENT head at reclaim time.
        return { exitCode: 0, stdout: revParseCalls === 1 ? 'carry-sha\n' : 'someone-elses-sha\n', stderr: '' };
      }
      return inner(opts);
    };
    const { deps, machineSandbox } = makeDeps({}, { machine });

    await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, carryDirty: true, deps });

    expect(machineSandbox.calls.filter((c) => c.args?.[0] === '-rf')).toEqual([]);
  });
});

describe('promoteProject — every step of the carry fails closed (#2207)', () => {
  const DIRTY = { exitCode: 0, stdout: `${CLEAN_STATUS} M src/index.ts\n`, stderr: '' };

  async function carry(deps: PromoteProjectDeps) {
    return promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, carryDirty: true, deps });
  }

  /** Fails ONE git subcommand on the project Sprite, leaving the rest working. */
  function failProjectGit(deps: PromoteProjectDeps, sub: string): void {
    const host = deps.host;
    deps.host = {
      ...host,
      provision: async (args) => {
        const handle = await host.provision(args);
        return {
          ...handle,
          exec: async (e) =>
            gitSubcommand(e.args) === sub
              ? { exitCode: 1, stdout: '', stderr: `fatal: ${sub} refused` }
              : handle.exec(e),
        };
      },
    };
  }

  it('given the branch read failing, should not guess at a branch name', async () => {
    const machine = makeMachineSandbox({ status: [DIRTY, { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' }] });
    const { deps, killCalls } = makeDeps({}, { machine });

    expect(await carry(deps)).toMatchObject({ ok: false, reason: 'carry_failed' });
    expect(killCalls).toEqual(['sbx-project-1']);
  });

  it('given staging failing, should stop before committing anything', async () => {
    const machine = makeMachineSandbox({ status: DIRTY, git: { add: { exitCode: 1, stdout: '', stderr: 'fatal: pathspec' } } });
    const { deps, machineSandbox } = makeDeps({}, { machine });

    const result = await carry(deps);

    expect(result).toMatchObject({ ok: false, reason: 'carry_failed' });
    expect(result.ok === false && result.detail).toContain('staging');
    expect(machineSandbox.calls.map((c) => gitSubcommand(c.args))).not.toContain('commit');
  });

  it('given the carry commit failing, should fail the promotion', async () => {
    const machine = makeMachineSandbox({ status: DIRTY, git: { commit: { exitCode: 1, stdout: '', stderr: 'fatal: no identity' } } });
    const { deps } = makeDeps({}, { machine });

    const result = await carry(deps);
    expect(result).toMatchObject({ ok: false, reason: 'carry_failed' });
    expect(result.ok === false && result.detail).toContain('committing');
  });

  it('given a DETACHED HEAD, should mint a ref so the bundle has something to carry', async () => {
    const machine = makeMachineSandbox({ status: { exitCode: 0, stdout: '## HEAD (no branch)\n M src/index.ts\n', stderr: '' } });
    const { deps, byId, machineSandbox } = makeDeps({}, { machine });

    expect(await carry(deps)).toMatchObject({ ok: true, carried: true });

    const branched = machineSandbox.calls.find((c) => gitSubcommand(c.args) === 'branch');
    expect(branched?.args).toEqual(['branch', '-f', 'pagespace-carry', 'HEAD']);
    const checkout = byId.get('sbx-project-1')?.execLog.find((e) => gitSubcommand(e.args) === 'checkout');
    expect(checkout?.args).toEqual(['checkout', '-B', 'pagespace-carry', 'pagespace-carry/pagespace-carry']);
  });

  it('given the detached-HEAD ref failing to mint, should fail the carry', async () => {
    const machine = makeMachineSandbox({
      status: { exitCode: 0, stdout: '## HEAD (no branch)\n M src/index.ts\n', stderr: '' },
      git: { branch: { exitCode: 1, stdout: '', stderr: 'fatal: bad ref' } },
    });
    const { deps } = makeDeps({}, { machine });

    expect(await carry(deps)).toMatchObject({ ok: false, reason: 'carry_failed' });
  });

  it('given the far-side checkout failing, should fail the carry', async () => {
    const machine = makeMachineSandbox({ status: DIRTY });
    const { deps } = makeDeps({}, { machine });
    failProjectGit(deps, 'checkout');

    const result = await carry(deps);
    expect(result).toMatchObject({ ok: false, reason: 'carry_failed' });
    expect(result.ok === false && result.detail).toContain('checking out');
  });

  it('given the far-side reset failing, should fail rather than leave the carry commit in the history', async () => {
    // The work IS on the Sprite at that point, but as a commit the user never
    // made. Reporting success would hand them a repo whose history is a lie.
    const machine = makeMachineSandbox({ status: DIRTY });
    const { deps, killCalls } = makeDeps({}, { machine });
    failProjectGit(deps, 'reset');

    expect(await carry(deps)).toMatchObject({ ok: false, reason: 'carry_failed' });
    expect(killCalls).toEqual(['sbx-project-1']);
  });

  it('given the bundle READ throwing, should fail closed', async () => {
    const machine = makeMachineSandbox({ status: DIRTY });
    machine.sandbox.readFileToBuffer = async () => {
      throw new Error('sprite disk error');
    };
    const { deps } = makeDeps({}, { machine });

    const result = await carry(deps);
    expect(result).toMatchObject({ ok: false, reason: 'carry_failed' });
    expect(result.ok === false && result.detail).toContain('sprite disk error');
  });

  it('given the bundle WRITE throwing, should fail closed', async () => {
    const machine = makeMachineSandbox({ status: DIRTY });
    const { deps } = makeDeps({}, { machine });
    const host = deps.host;
    deps.host = {
      ...host,
      provision: async (args) => {
        const handle = await host.provision(args);
        return {
          ...handle,
          writeFiles: async () => {
            throw new Error('sprite write error');
          },
        };
      },
    };

    const result = await carry(deps);
    expect(result).toMatchObject({ ok: false, reason: 'carry_failed' });
    expect(result.ok === false && result.detail).toContain('sprite write error');
  });

  it('given the SIZE PROBE throwing, should fail closed rather than read an unbounded file', async () => {
    const machine = makeMachineSandbox({ status: DIRTY });
    const inner = machine.sandbox.runCommand;
    machine.sandbox.runCommand = async (opts) => {
      if (opts.cmd === 'stat') throw new Error('stat blew up');
      return inner(opts);
    };
    const { deps } = makeDeps({}, { machine });

    expect(await carry(deps)).toMatchObject({ ok: false, reason: 'carry_failed' });
  });

  it('given the machine Sprite going unreachable mid-carry, should fail closed', async () => {
    const machine = makeMachineSandbox({ status: DIRTY });
    let bundled = false;
    const inner = machine.sandbox.runCommand;
    machine.sandbox.runCommand = async (opts) => {
      if (opts.cmd === 'git' && gitSubcommand(opts.args) === 'bundle') bundled = true;
      return inner(opts);
    };
    const { deps } = makeDeps({}, { machine });
    // Everything up to and including the bundle works; the reconnect that the
    // byte transfer needs does not.
    deps.reconnect = async () => (bundled ? null : machine.sandbox);

    const result = await carry(deps);
    expect(result).toMatchObject({ ok: false, reason: 'carry_failed' });
    expect(result.ok === false && result.detail).toContain('unreachable');
  });
});

describe('promoteProject — an unconfirmable carry sha never licenses a delete (#2207)', () => {
  const DIRTY = { exitCode: 0, stdout: `${CLEAN_STATUS} M src/index.ts\n`, stderr: '' };

  it('given HEAD unreadable after the carry commit, should promote but leave the old checkout alone', async () => {
    const machine = makeMachineSandbox({
      status: [DIRTY, { exitCode: 0, stdout: '## main...origin/main [ahead 1]\n', stderr: '' }],
      git: { 'rev-parse': { exitCode: 128, stdout: '', stderr: 'fatal: ambiguous argument' } },
    });
    const { deps, machineSandbox } = makeDeps({}, { machine });

    const result = await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, carryDirty: true, deps });

    expect(result).toMatchObject({ ok: true, carried: true });
    expect(machineSandbox.calls.filter((c) => c.args?.[0] === '-rf')).toEqual([]);
  });

  it('given an EMPTY sha, should treat it as unreadable rather than as a match', async () => {
    const machine = makeMachineSandbox({
      status: [DIRTY, { exitCode: 0, stdout: '## main...origin/main [ahead 1]\n', stderr: '' }],
      git: { 'rev-parse': { exitCode: 0, stdout: '\n', stderr: '' } },
    });
    const { deps, machineSandbox } = makeDeps({}, { machine });

    await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, carryDirty: true, deps });

    expect(machineSandbox.calls.filter((c) => c.args?.[0] === '-rf')).toEqual([]);
  });

  it('given the machine Sprite unacquirable for the byte transfer, should fail the carry', async () => {
    const machine = makeMachineSandbox({ status: DIRTY });
    let bundled = false;
    const inner = machine.sandbox.runCommand;
    machine.sandbox.runCommand = async (opts) => {
      if (opts.cmd === 'git' && gitSubcommand(opts.args) === 'bundle') bundled = true;
      return inner(opts);
    };
    const { deps } = makeDeps({}, { machine });
    deps.acquireMachineSandbox = async () =>
      bundled ? { ok: false, reason: 'machine_unavailable' } : { ok: true, sandboxId: MACHINE_SANDBOX_ID, resumed: false };

    expect(await promoteProject({ machineId: MACHINE_ID, projectName: PROJECT_NAME, actor, carryDirty: true, deps })).toMatchObject({
      ok: false,
      reason: 'carry_failed',
    });
  });
});
