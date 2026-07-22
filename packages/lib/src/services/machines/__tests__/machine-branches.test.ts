import { describe, it, expect, vi } from 'vitest';
import {
  spawnBranch,
  attachBranch,
  killBranch,
  listBranches,
  propagateClaudeCredential,
  BRANCH_REPO_PATH,
  type MachineBranchesDeps,
  type MachineBranchProjectLookup,
  type BranchStorageMeasurement,
} from '../machine-branches';
import type { MachineBranchStore, MachineBranchRecord } from '../machine-branches-store';
import { deriveBranchSessionKey } from '../branch-session';
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
  const key = (machineId: string, projectName: string, branchName: string) => `${machineId}\0${projectName}\0${branchName}`;
  for (const row of seed) rows.set(key(row.machineId, row.projectName, row.branchName), row);
  let counter = 0;
  const store: MachineBranchStore = {
    list: async (machineId, projectName) =>
      [...rows.values()].filter((r) => r.machineId === machineId && r.projectName === projectName),
    findByName: async (machineId, projectName, branchName) => rows.get(key(machineId, projectName, branchName)) ?? null,
    findById: async (id) => [...rows.values()].find((r) => r.id === id) ?? null,
    create: async (input) => {
      const k = key(input.machineId, input.projectName, input.branchName);
      if (rows.has(k)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      counter += 1;
      const row: MachineBranchRecord = {
        id: `branch-${counter}`,
        ownerId: input.ownerId,
        machineId: input.machineId,
        projectName: input.projectName,
        branchName: input.branchName,
        sessionKey: input.sessionKey,
        sandboxId: input.sandboxId,
        spriteInstanceId: input.spriteInstanceId,
        teardownRequestedAt: null,
        spriteTornDownAt: null,
        createdAt: input.now,
        updatedAt: input.now,
      };
      rows.set(k, row);
      return row;
    },
    updateSandboxId: async ({ id, previousSandboxId, sandboxId, spriteInstanceId, now }) => {
      for (const [k, row] of rows) {
        if (row.id === id) {
          if (row.sandboxId !== previousSandboxId) return false;
          // Mirrors the real store: recording a LIVE replacement Sprite clears BOTH
          // teardown marks. A surviving `teardownRequestedAt` would let the
          // reconciler destroy this live VM (and turn a later reversible trash into
          // an irreversible kill); a surviving `spriteTornDownAt` would hide it.
          rows.set(k, {
            ...row,
            sandboxId,
            spriteInstanceId,
            spriteTornDownAt: null,
            teardownRequestedAt: null,
            updatedAt: now,
          });
          return true;
        }
      }
      return false;
    },
    remove: async (machineId, projectName, branchName) => {
      rows.delete(key(machineId, projectName, branchName));
    },
    removeIfSandbox: async ({ id, sandboxId }) => {
      // Mirrors the real store: a row whose sandboxId has changed under us now
      // points at a LIVE replacement Sprite — deleting it would orphan that VM.
      for (const [k, row] of rows) {
        if (row.id === id) {
          if (row.sandboxId !== sandboxId) return false;
          rows.delete(k);
          return true;
        }
      }
      return false;
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
  fileModes: Map<string, number | undefined>;
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
      spriteInstanceId: `inst-${state.machineId}`,
      exec: async (args) => {
        state.execLog.push(args);
        if (execImpl) return execImpl(state, args);
        // Default `mv <src> <dst>` semantics (moves the in-memory entry),
        // so tests can assert the write-to-temp-then-atomic-rename
        // sequence `propagateClaudeCredential` uses lands the final
        // content at the REAL path, not just the exec call shape.
        if (args.cmd === 'mv' && args.args?.[0] !== undefined && args.args[1] !== undefined) {
          const [src, dst] = args.args;
          const content = state.files.get(src);
          if (content !== undefined) {
            state.files.set(dst, content);
            state.fileModes.set(dst, state.fileModes.get(src));
          }
          state.files.delete(src);
          state.fileModes.delete(src);
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      writeFiles: async (files) => {
        for (const f of files) {
          state.files.set(f.path, String(f.content));
          state.fileModes.set(f.path, f.mode);
        }
      },
      readFile: async ({ path }) => {
        const content = state.files.get(path);
        return content === undefined ? null : Buffer.from(content);
      },
      createCheckpoint: async () => {},
      stream: async () => {
        throw new Error('not used by machine-branches');
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
        state = { machineId: `sbx-${counter}`, execLog: [], files: new Map(), fileModes: new Map() };
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
    resolveRootMachineHandle: async () => null,
    quota: { acquireSlot: () => true, releaseSlot: () => {} },
    buildEnv: () => ({ NODE_ENV: 'test' }),
    audit: async (input) => {
      auditCalls.push(input);
    },
    ...overrides,
  };
  return { deps, store, host, auditCalls };
}

describe('spawnBranch', () => {
  it('given a valid spawn, should provision exactly one Sprite, clone the repo, checkout the branch off origin, and persist the row', async () => {
    const { host, provisionCalls, byId } = makeFakeHost();
    const { deps, store } = makeDeps({ host });

    const result = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });

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

    const result = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    expect(result).toEqual({ ok: false, reason: 'kill_switch_off' });
    expect(provisionCalls).toHaveLength(0);
  });

  it('given free text as the branch name, should NORMALIZE it rather than refuse — and check out the normalized ref', async () => {
    const { host, byId } = makeFakeHost();
    const { deps, store } = makeDeps({ host });

    const result = await spawnBranch({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: 'My Cool Feature',
      actor,
      deps,
    });

    expect(result).toMatchObject({ ok: true, branchName: 'my-cool-feature' });
    if (!result.ok) throw new Error('expected ok');

    // The normalized name is what git sees, and what the tracking row holds —
    // the raw text never reaches either.
    const state = byId.get(result.sandboxId);
    expect(state?.execLog[1]).toMatchObject({
      args: ['checkout', '-b', 'my-cool-feature', 'origin/my-cool-feature'],
    });
    expect(await store.findByName(TERMINAL_ID, PROJECT_NAME, 'my-cool-feature')).toMatchObject({
      branchName: 'my-cool-feature',
    });
    expect(await store.findByName(TERMINAL_ID, PROJECT_NAME, 'My Cool Feature')).toBeNull();
  });

  it('given a name with no upstream branch, should report createdNew so an empty checkout is never silent', async () => {
    // Normalization can rewrite a name that DOES exist upstream into one that
    // does not (`_wip` → `wip`: git allows a leading `_`, our narrower charset
    // does not). git's fallback then creates a NEW EMPTY branch off HEAD. The
    // caller must be able to SEE that, rather than be told "here's your branch".
    const { host } = makeFakeHost((_state, args) => {
      // No `origin/wip` upstream — the `origin/`-tracking checkout fails.
      const tracksOrigin = (args.args ?? []).some((a) => a.startsWith('origin/'));
      return tracksOrigin
        ? { exitCode: 1, stdout: '', stderr: "fatal: 'origin/wip' is not a commit" }
        : { exitCode: 0, stdout: '', stderr: '' };
    });
    const { deps } = makeDeps({ host });

    const result = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: '_wip', actor, deps });

    expect(result).toMatchObject({ ok: true, branchName: 'wip', createdNew: true });
  });

  it('given a branch that DOES exist upstream, should report createdNew: false', async () => {
    const { host } = makeFakeHost();
    const { deps } = makeDeps({ host });

    const result = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });

    expect(result).toMatchObject({ ok: true, branchName: 'main', createdNew: false });
  });

  it('given free text as the PROJECT name, should normalize the lookup and find the project', async () => {
    // `addProject` persists the canonical project name, so free text that
    // created a project must also be able to spawn a branch in it.
    const lookedUp: string[] = [];
    const { deps } = makeDeps({
      projectStore: {
        findByName: async (_machineId: string, name: string) => {
          lookedUp.push(name);
          return name === 'my-cool-feature' ? { repoUrl: REPO_URL } : null;
        },
      },
    });

    const result = await spawnBranch({
      machineId: TERMINAL_ID,
      projectName: 'My Cool Feature',
      branchName: 'main',
      actor,
      deps,
    });

    expect(result).toMatchObject({ ok: true });
    expect(lookedUp).toEqual(['my-cool-feature']);
  });

  it('given a hostile branch name, should normalize it into a safe ref instead of erroring', async () => {
    const { deps, store } = makeDeps({});
    const result = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: '../etc', actor, deps });

    expect(result).toMatchObject({ ok: true, branchName: 'etc' });
    expect(await store.findByName(TERMINAL_ID, PROJECT_NAME, 'etc')).toMatchObject({ branchName: 'etc' });
  });

  it('given two spellings of the same name, should reattach to ONE branch-terminal rather than spawn two', async () => {
    const { host, provisionCalls } = makeFakeHost();
    const { deps } = makeDeps({ host });

    const first = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'My Cool Feature', actor, deps });
    const second = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'my---cool feature', actor, deps });

    expect(first).toMatchObject({ ok: true, resumed: false });
    expect(second).toMatchObject({ ok: true, resumed: true, branchName: 'my-cool-feature' });
    expect(provisionCalls).toHaveLength(1);
  });

  it('given no such project on this machine, should refuse', async () => {
    const { deps } = makeDeps({ projectStore: makeProjectStore(null) });
    const result = await spawnBranch({ machineId: TERMINAL_ID, projectName: 'nope', branchName: 'main', actor, deps });
    expect(result).toEqual({ ok: false, reason: 'project_not_found' });
  });

  it('given containment is unverified, should refuse without provisioning', async () => {
    const { host, provisionCalls } = makeFakeHost();
    const { deps } = makeDeps({ host, checkFullEgressEnablement: async () => ({ ok: false, reason: 'containment_unverified' }) });

    const result = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
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

    const result = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    expect(result).toMatchObject({ ok: false, reason: 'clone_failed' });
    expect(killCalls).toHaveLength(1);
    expect(await store.list(TERMINAL_ID, PROJECT_NAME)).toEqual([]);
  });

  it('given clone fails because a concurrent spawn already committed the SAME shared Sprite, should NOT kill it and should report resumed', async () => {
    // MachineHost.provision is name-keyed/idempotent — two concurrent
    // spawnBranch calls for the same new branch can both resolve to the SAME
    // physical Sprite. Simulate that here: the moment OUR clone runs, a
    // "concurrent" call has already recorded THIS SAME Sprite (state.machineId)
    // as the winning row, so our own clone fails as redundant (e.g. the
    // destination directory already exists).
    const { store } = makeStore();
    const { host, killCalls } = makeFakeHost((state, args) => {
      if (args.cmd === 'git' && args.args?.[0] === 'clone') {
        void store.create({
          ownerId: 'other-user',
          machineId: TERMINAL_ID,
          projectName: PROJECT_NAME,
          branchName: 'main',
          sessionKey: deriveBranchSessionKey({
            tenantId: actor.tenantId,
            machineId: TERMINAL_ID,
            projectName: PROJECT_NAME,
            branchName: 'main',
            secret: SECRET,
          }),
          sandboxId: state.machineId,
          spriteInstanceId: null,
          now: NOW,
        });
        return { exitCode: 128, stdout: '', stderr: 'fatal: destination path already exists' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const { deps } = makeDeps({ host, store });

    const result = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.resumed).toBe(true);
    // The shared Sprite must NOT have been killed — that would destroy the
    // concurrent winner's already-tracked, live branch-terminal.
    expect(killCalls).toHaveLength(0);
    expect((await store.findByName(TERMINAL_ID, PROJECT_NAME, 'main'))?.sandboxId).toBe(result.sandboxId);
  });

  it('given the unique-violation race with a genuinely DIFFERENT winning Sprite, should kill its own redundant Sprite and return the winner\'s', async () => {
    const store = makeStore().store;
    const { host, killCalls, provisionCalls } = makeFakeHost((_state, args) => {
      if (args.cmd === 'git' && args.args?.[0] === 'checkout' && args.args?.includes('origin/main')) {
        // Simulate a concurrent spawnBranch call finishing first on its OWN,
        // genuinely independent Sprite (not the one we hold).
        void store.create({
          ownerId: 'other-user',
          machineId: TERMINAL_ID,
          projectName: PROJECT_NAME,
          branchName: 'main',
          sessionKey: deriveBranchSessionKey({
            tenantId: actor.tenantId,
            machineId: TERMINAL_ID,
            projectName: PROJECT_NAME,
            branchName: 'main',
            secret: SECRET,
          }),
          sandboxId: 'sbx-other-winner',
          spriteInstanceId: 'inst-other-winner',
          now: NOW,
        });
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const { deps } = makeDeps({ host, store });

    const result = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    expect(result).toEqual({ ok: true, sandboxId: 'sbx-other-winner', branchName: 'main', resumed: true });
    // Our own redundant Sprite is killed, but NEVER the winner's.
    expect(provisionCalls).toHaveLength(1);
    expect(killCalls).toHaveLength(1);
    expect(killCalls).not.toContain('sbx-other-winner');
  });

  it('given a branch whose Sprite was TORN DOWN (machine trashed, then restored), should re-provision and CLEAR the torn-down stamp', async () => {
    // The subtlest invariant in the orphan-reconcile design: a re-provisioned
    // branch Sprite is LIVE again, so its row must stop looking reclaimed. If the
    // stamp survived here, the new Sprite would be invisible to BOTH the orphan
    // reconciler and the hard-purge guard — i.e. it could be orphaned and billed
    // forever, the exact bug the reconciler exists to prevent.
    const sessionKey = deriveBranchSessionKey({
      tenantId: actor.tenantId,
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: 'main',
      secret: SECRET,
    });
    const { store } = makeStore([
      {
        id: 'branch-torndown',
        ownerId: actor.userId,
        machineId: TERMINAL_ID,
        projectName: PROJECT_NAME,
        branchName: 'main',
        sessionKey,
        // Not registered with the fake host → attach returns null, i.e. the
        // Sprite the reconciler killed is genuinely gone.
        sandboxId: 'sbx-reclaimed',
        spriteInstanceId: 'inst-reclaimed',
        teardownRequestedAt: NOW,
        spriteTornDownAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const { host } = makeFakeHost();
    const { deps } = makeDeps({ host, store });

    const result = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });

    expect(result.ok).toBe(true);
    const row = await store.findByName(TERMINAL_ID, PROJECT_NAME, 'main');
    expect(row?.spriteTornDownAt).toBeNull();
    expect(row?.sandboxId).not.toBe('sbx-reclaimed');
  });

  it('given a concurrent re-provision-after-vanish race, should not overwrite the winner\'s row and should kill its own redundant Sprite', async () => {
    let armed = false;
    let raceRowId = '';
    let racePreviousSandboxId = '';
    const { host, killCalls } = makeFakeHost((_state, args) => {
      if (armed && args.cmd === 'git' && args.args?.[0] === 'clone') {
        armed = false;
        // Simulate a truly concurrent racer winning the re-provision update
        // for the SAME vanished branch just before we do.
        void store.updateSandboxId({
          spriteInstanceId: 'inst-race',
          id: raceRowId,
          previousSandboxId: racePreviousSandboxId,
          sandboxId: 'sbx-concurrent-winner',
          now: NOW,
        });
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const { deps, store } = makeDeps({ host });

    const first = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    if (!first.ok) throw new Error('expected ok');
    const before = await store.findByName(TERMINAL_ID, PROJECT_NAME, 'main');
    if (!before) throw new Error('expected row');
    await host.kill({ machineId: first.sandboxId });

    raceRowId = before.id;
    racePreviousSandboxId = before.sandboxId;
    armed = true;

    const second = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    expect(second).toEqual({ ok: true, sandboxId: 'sbx-concurrent-winner', branchName: 'main', resumed: true });
    // Our own re-provisioned (now-redundant) Sprite is killed; the winner's never is.
    expect(killCalls).not.toContain('sbx-concurrent-winner');
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
      machineId: TERMINAL_ID,
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

    const result = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    expect(result).toMatchObject({ ok: false, reason: 'checkout_failed' });
    expect(killCalls).toHaveLength(1);
    expect(await store.list(TERMINAL_ID, PROJECT_NAME)).toEqual([]);
  });

  it('given an already-spawned branch with a live Sprite, should resume without re-cloning', async () => {
    const { host, provisionCalls } = makeFakeHost();
    const { deps } = makeDeps({ host });

    const first = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    expect(first).toMatchObject({ ok: true, resumed: false });

    const second = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    expect(second).toMatchObject({ ok: true, resumed: true });
    if (!first.ok || !second.ok) throw new Error('expected ok');
    expect(second.sandboxId).toBe(first.sandboxId);
    // Only ONE provision call — resume reattaches instead of re-provisioning.
    expect(provisionCalls).toHaveLength(1);
  });

  it('given a tracked branch whose Sprite has vanished, should re-provision under the SAME session key', async () => {
    const { host, provisionCalls } = makeFakeHost();
    const { deps, store } = makeDeps({ host });

    const first = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    if (!first.ok) throw new Error('expected ok');

    const before = await store.findByName(TERMINAL_ID, PROJECT_NAME, 'main');
    // Simulate the Sprite vanishing (reaped) without going through killBranch.
    await host.kill({ machineId: first.sandboxId });

    const second = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
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

    const result = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
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

    const a = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'branch-a', actor, deps });
    const b = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'branch-b', actor, deps });
    if (!a.ok || !b.ok) throw new Error('expected both spawns to succeed');

    expect(a.sandboxId).not.toBe(b.sandboxId);
    expect(provisionCalls).toHaveLength(2);
    expect(new Set(provisionCalls).size).toBe(2);
  });

  it("a file written into branch A's Sprite must be ABSENT from branch B's Sprite (no shared filesystem)", async () => {
    const { host } = makeFakeHost();
    const { deps } = makeDeps({ host });

    const a = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'branch-a', actor, deps });
    const b = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'branch-b', actor, deps });
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

    const a = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'branch-a', actor, deps });
    const b = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'branch-b', actor, deps });
    if (!a.ok || !b.ok) throw new Error('expected both spawns to succeed');

    const stateA = byId.get(a.sandboxId);
    const stateB = byId.get(b.sandboxId);

    expect(stateA?.execLog.some((c) => c.args?.includes('branch-a'))).toBe(true);
    expect(stateA?.execLog.some((c) => c.args?.includes('branch-b'))).toBe(false);
    expect(stateB?.execLog.some((c) => c.args?.includes('branch-b'))).toBe(true);
    expect(stateB?.execLog.some((c) => c.args?.includes('branch-a'))).toBe(false);
  });
});

const noRootHandle = async () => null;

describe('attachBranch', () => {
  it('given an existing, live branch, should reattach to its Sprite', async () => {
    const { host } = makeFakeHost();
    const { deps, store } = makeDeps({ host });
    const spawned = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    if (!spawned.ok) throw new Error('expected ok');

    const result = await attachBranch({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: 'main',
      store,
      host,
      resolveRootMachineHandle: noRootHandle,
    });
    expect(result).toEqual({ ok: true, sandboxId: spawned.sandboxId, branchName: 'main' });
  });

  it('given the free text the branch was CREATED with, should normalize the lookup and still find it', async () => {
    const { host } = makeFakeHost();
    const { deps, store } = makeDeps({ host });
    const spawned = await spawnBranch({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: 'My Cool Feature',
      actor,
      deps,
    });
    if (!spawned.ok) throw new Error('expected ok');

    const result = await attachBranch({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: 'My Cool Feature',
      store,
      host,
      resolveRootMachineHandle: noRootHandle,
    });
    expect(result).toEqual({ ok: true, sandboxId: spawned.sandboxId, branchName: 'my-cool-feature' });
  });

  it('given no tracked branch, should return not_found', async () => {
    const { host } = makeFakeHost();
    const { store } = makeDeps({ host });
    const result = await attachBranch({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: 'nope',
      store,
      host,
      resolveRootMachineHandle: noRootHandle,
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('given a tracked branch whose Sprite has vanished, should return vanished', async () => {
    const { host } = makeFakeHost();
    const { deps, store } = makeDeps({ host });
    const spawned = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    if (!spawned.ok) throw new Error('expected ok');

    await host.kill({ machineId: spawned.sandboxId });

    const result = await attachBranch({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: 'main',
      store,
      host,
      resolveRootMachineHandle: noRootHandle,
    });
    expect(result).toEqual({ ok: false, reason: 'vanished' });
  });
});

describe('Claude Code credential propagation', () => {
  /** A fake root Machine's Sprite pre-seeded with the given files, standing in for `resolveRootMachineHandle`. */
  function makeRootHandle(files: Record<string, string>): MachineHandle {
    return {
      machineId: 'root-sbx',
      spriteInstanceId: null,
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      writeFiles: async () => {},
      readFile: async ({ path }) => (path in files ? Buffer.from(files[path]!) : null),
      createCheckpoint: async () => {},
      stream: async () => {
        throw new Error('not used');
      },
      listStreams: async () => [],
      killSession: async () => {},
    };
  }

  it('given the root Machine has a live Claude credential, should copy it into a freshly spawned branch Sprite', async () => {
    const { host, byId } = makeFakeHost();
    const rootHandle = makeRootHandle({ '/home/sprite/.claude/.credentials.json': 'secret-token' });
    const { deps } = makeDeps({ host, resolveRootMachineHandle: async () => rootHandle });

    const result = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    if (!result.ok) throw new Error('expected ok');

    const state = byId.get(result.sandboxId);
    expect(state?.files.get('/home/sprite/.claude/.credentials.json')).toBe('secret-token');
  });

  it('given the root Machine also has a Claude config file, should copy that too', async () => {
    const { host, byId } = makeFakeHost();
    const rootHandle = makeRootHandle({
      '/home/sprite/.claude/.credentials.json': 'secret-token',
      '/home/sprite/.claude.json': '{"theme":"dark"}',
    });
    const { deps } = makeDeps({ host, resolveRootMachineHandle: async () => rootHandle });

    const result = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    if (!result.ok) throw new Error('expected ok');

    const state = byId.get(result.sandboxId);
    expect(state?.files.get('/home/sprite/.claude.json')).toBe('{"theme":"dark"}');
  });

  it('given the root Machine has no live session, should skip the copy without failing the spawn', async () => {
    const { host, byId } = makeFakeHost();
    const { deps } = makeDeps({ host, resolveRootMachineHandle: async () => null });

    const result = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    const state = byId.get(result.sandboxId);
    expect(state?.files.has('/home/sprite/.claude/.credentials.json')).toBe(false);
  });

  it('given the root Machine is live but has never logged into Claude Code, should skip the copy without failing the spawn', async () => {
    const { host, byId } = makeFakeHost();
    const rootHandle = makeRootHandle({});
    const { deps } = makeDeps({ host, resolveRootMachineHandle: async () => rootHandle });

    const result = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    const state = byId.get(result.sandboxId);
    expect(state?.files.has('/home/sprite/.claude/.credentials.json')).toBe(false);
  });

  it('given resolving the root handle throws, should not fail the spawn', async () => {
    const { host } = makeFakeHost();
    const { deps } = makeDeps({
      host,
      resolveRootMachineHandle: async () => {
        throw new Error('root Sprite unreachable');
      },
    });

    const result = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    expect(result.ok).toBe(true);
  });

  it('given a refreshed credential on reattach (existing, live branch-terminal), should re-copy rather than only copying once at first spawn', async () => {
    const { host } = makeFakeHost();
    let currentToken = 'first-token';
    const rootHandle = () => makeRootHandle({ '/home/sprite/.claude/.credentials.json': currentToken });
    const { deps } = makeDeps({ host, resolveRootMachineHandle: async () => rootHandle() });

    const first = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    if (!first.ok) throw new Error('expected ok');

    currentToken = 'refreshed-token';
    const second = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    expect(second).toMatchObject({ ok: true, resumed: true });
    if (!second.ok) throw new Error('expected ok');

    const state = (await host.attach({ machineId: second.sandboxId }));
    expect((await state?.readFile({ path: '/home/sprite/.claude/.credentials.json' }))?.toString('utf8')).toBe(
      'refreshed-token',
    );
  });

  it('given the root read later comes back empty (e.g. a `claude logout`, OR simply a transient root-Sprite read failure), should NOT delete the branch\'s existing valid credential', async () => {
    // `readFile` maps EVERY read failure to the same `null` a missing file
    // produces (see the doc comment on `propagateClaudeCredential`) — an
    // empty read is NOT reliable evidence of a real logout, so deleting on
    // it would risk destroying a perfectly valid, working branch credential
    // on a transient hiccup. Tried deleting on this signal and reverted it
    // (see review history) — this test guards against reintroducing it.
    const { host, byId } = makeFakeHost();
    let rootFiles: Record<string, string> = { '/home/sprite/.claude/.credentials.json': 'first-token' };
    const { deps } = makeDeps({ host, resolveRootMachineHandle: async () => makeRootHandle(rootFiles) });

    const first = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    if (!first.ok) throw new Error('expected ok');
    expect(byId.get(first.sandboxId)?.files.get('/home/sprite/.claude/.credentials.json')).toBe('first-token');

    // The root read now comes back empty (logout, or just a transient blip —
    // indistinguishable from here).
    rootFiles = {};
    const second = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    expect(second).toMatchObject({ ok: true, resumed: true });
    if (!second.ok) throw new Error('expected ok');

    expect(byId.get(second.sandboxId)?.files.get('/home/sprite/.claude/.credentials.json')).toBe('first-token');
  });

  it('given the root Machine has never had a credential, should skip the copy without ever touching the branch Sprite\'s exec log', async () => {
    const { host, byId } = makeFakeHost();
    const rootHandle = makeRootHandle({});
    const { deps } = makeDeps({ host, resolveRootMachineHandle: async () => rootHandle });

    const result = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    const state = byId.get(result.sandboxId);
    expect(state?.execLog.filter((c) => c.cmd === 'rm' || c.cmd === 'chmod')).toEqual([]);
  });

  it('should also propagate the credential on attachBranch (not only spawnBranch)', async () => {
    const { host } = makeFakeHost();
    const { deps, store } = makeDeps({ host });
    const spawned = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    if (!spawned.ok) throw new Error('expected ok');

    const rootHandle = makeRootHandle({ '/home/sprite/.claude/.credentials.json': 'attach-time-token' });
    const result = await attachBranch({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: 'main',
      store,
      host,
      resolveRootMachineHandle: async () => rootHandle,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    const handle = await host.attach({ machineId: result.sandboxId });
    expect((await handle?.readFile({ path: '/home/sprite/.claude/.credentials.json' }))?.toString('utf8')).toBe(
      'attach-time-token',
    );
  });

  it('should write the credential file with restrictive (0o600) permissions', async () => {
    const { host, byId } = makeFakeHost();
    const rootHandle = makeRootHandle({
      '/home/sprite/.claude/.credentials.json': 'secret-token',
      '/home/sprite/.claude.json': '{"theme":"dark"}',
    });
    const { deps } = makeDeps({ host, resolveRootMachineHandle: async () => rootHandle });

    const result = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    if (!result.ok) throw new Error('expected ok');

    const state = byId.get(result.sandboxId);
    expect(state?.fileModes.get('/home/sprite/.claude/.credentials.json')).toBe(0o600);
  });

  it('should write to a temp path then atomically rename it onto the real destination, for both the credentials and config files — a fresh CREATION is what makes 0o600 take effect reliably even on a refresh', async () => {
    // `writeFiles`' `mode` only applies at file CREATION (POSIX open()
    // semantics) — an overwrite of an already-existing file silently keeps
    // whatever permissions it already had. Writing to a temp path (which
    // never existed before) makes every write a creation, and `mv` on the
    // same filesystem is atomic — no separate chmod step, no window where
    // the destination is at the wrong mode or briefly absent.
    const { host, byId } = makeFakeHost();
    const rootHandle = makeRootHandle({
      '/home/sprite/.claude/.credentials.json': 'secret-token',
      '/home/sprite/.claude.json': '{"theme":"dark"}',
    });
    const { deps } = makeDeps({ host, resolveRootMachineHandle: async () => rootHandle });

    const result = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    if (!result.ok) throw new Error('expected ok');

    const state = byId.get(result.sandboxId);
    // The temp path is generation-suffixed (not a fixed name — see doc
    // comment on why) and cleared BEFORE each write too — writing to an
    // already-existing temp path would silently keep whatever mode it
    // already had.
    const tempPathPattern = /^\/home\/sprite\/\.claude(\/\.credentials\.json|\.json)\.tmp\.[a-z0-9]+$/;
    const rmCalls = state?.execLog.filter((c) => c.cmd === 'rm') ?? [];
    expect(rmCalls).toHaveLength(2);
    for (const call of rmCalls) {
      expect(call.args?.[0]).toBe('-f');
      expect(call.args?.[1]).toMatch(tempPathPattern);
    }
    const mvCalls = state?.execLog.filter((c) => c.cmd === 'mv') ?? [];
    expect(mvCalls).toHaveLength(2);
    expect(mvCalls[0]?.args?.[0]).toMatch(tempPathPattern);
    expect(mvCalls[0]?.args?.[1]).toBe('/home/sprite/.claude/.credentials.json');
    expect(mvCalls[1]?.args?.[0]).toMatch(tempPathPattern);
    expect(mvCalls[1]?.args?.[1]).toBe('/home/sprite/.claude.json');
    // The fake host's `mv` moves the in-memory entry — the final content and
    // mode must land at the REAL path, with no lingering temp-path entry.
    expect(state?.files.get('/home/sprite/.claude/.credentials.json')).toBe('secret-token');
    expect(state?.fileModes.get('/home/sprite/.claude/.credentials.json')).toBe(0o600);
    expect([...(state?.files.keys() ?? [])].some((k) => tempPathPattern.test(k))).toBe(false);
  });

  it('should pass a bounded timeoutMs on every housekeeping rm/mv exec — the Sprite runner only installs its SIGKILL timer when one is supplied, so a call with none is unbounded at the transport level', async () => {
    const { host, byId } = makeFakeHost();
    const rootHandle = makeRootHandle({ '/home/sprite/.claude/.credentials.json': 'secret-token' });
    const { deps } = makeDeps({ host, resolveRootMachineHandle: async () => rootHandle });

    const result = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    if (!result.ok) throw new Error('expected ok');

    const state = byId.get(result.sandboxId);
    const housekeepingCalls = state?.execLog.filter((c) => c.cmd === 'rm' || c.cmd === 'mv') ?? [];
    expect(housekeepingCalls.length).toBeGreaterThan(0);
    for (const call of housekeepingCalls) {
      expect(call.timeoutMs).toBeGreaterThan(0);
      expect(call.maxBytes).toBeGreaterThan(0);
    }
  });

  it('given an overlapping call reads an OLDER credential and then stalls, should skip its own mv once a NEWER call has already landed — never clobbering the newer credential', async () => {
    // `withTimeout` deliberately does not cancel a slow call's underlying
    // work — it keeps running in the background. Without the generation
    // check, that stalled call finishing LATER with stale data would
    // overwrite a newer, already-landed credential from a faster call that
    // started after it.
    const { host, byId } = makeFakeHost();
    const handle = await host.provision({ name: 'branch-sprite-race', substrate: { kind: 'sprite' }, options: {} });

    // Call A: reads an OLD token, but its root resolution stays pending
    // until manually released — simulating a stall on a flaky root Sprite.
    let releaseA!: () => void;
    const aRootReady = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const callA = propagateClaudeCredential({
      machineId: TERMINAL_ID,
      branchHandle: handle,
      resolveRootMachineHandle: async () => {
        await aRootReady;
        return makeRootHandle({ '/home/sprite/.claude/.credentials.json': 'old-token' });
      },
    });

    // Call B starts after A and finishes normally with a NEWER (rotated)
    // token, while A is still stalled.
    const rootHandleB = makeRootHandle({ '/home/sprite/.claude/.credentials.json': 'rotated-token' });
    await propagateClaudeCredential({
      machineId: TERMINAL_ID,
      branchHandle: handle,
      resolveRootMachineHandle: async () => rootHandleB,
    });
    expect(byId.get(handle.machineId)?.files.get('/home/sprite/.claude/.credentials.json')).toBe('rotated-token');

    // Now let A's stalled resolution proceed — it should detect a newer
    // generation already landed and skip its own mv rather than clobber it.
    releaseA();
    await callA;

    expect(byId.get(handle.machineId)?.files.get('/home/sprite/.claude/.credentials.json')).toBe('rotated-token');
  });

  it('given the mv exec fails, should leave the EXISTING valid credential at the real path untouched (no window of total absence) and clean up the orphaned temp file', async () => {
    // The core property this design exists for: a failed rename must never
    // regress a branch from "has a valid, working credential" to "has
    // none at all" — that would be a regression on exactly the transient
    // Sprite/FS hiccups this best-effort path is supposed to tolerate.
    const { host, byId } = makeFakeHost((state, args) => {
      if (args.cmd === 'mv') return { exitCode: 1, stdout: '', stderr: 'mv: input/output error' };
      if (args.cmd === 'rm' && args.args?.[0] === '-f' && args.args[1] !== undefined) {
        state.files.delete(args.args[1]);
        state.fileModes.delete(args.args[1]);
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    // Provision a branch Sprite directly and seed it with an existing,
    // valid credential — as if a prior successful copy already happened.
    const handle = await host.provision({ name: 'branch-sprite', substrate: { kind: 'sprite' }, options: {} });
    await handle.writeFiles([{ path: '/home/sprite/.claude/.credentials.json', content: 'still-valid-token', mode: 0o600 }]);

    const rootHandle = makeRootHandle({ '/home/sprite/.claude/.credentials.json': 'refreshed-token' });
    await propagateClaudeCredential({
      machineId: TERMINAL_ID,
      branchHandle: handle,
      resolveRootMachineHandle: async () => rootHandle,
    });

    const state = byId.get(handle.machineId);
    // The refresh's mv failed — the credential at the real path must be the
    // one that was there before the failed refresh, not gone.
    expect(state?.files.get('/home/sprite/.claude/.credentials.json')).toBe('still-valid-token');
    // The orphaned (generation-suffixed) temp file must have been cleaned
    // up (best-effort).
    const tempPathPattern = /^\/home\/sprite\/\.claude\/\.credentials\.json\.tmp\.[a-z0-9]+$/;
    expect([...(state?.files.keys() ?? [])].some((k) => tempPathPattern.test(k))).toBe(false);
  });

  it('given the temp-clearing rm exec fails (non-zero exit), should abort BEFORE writing rather than assume the temp path is clear, and should leave any existing valid credential untouched', async () => {
    // If the clear itself fails, the temp path might still hold a stale
    // file — writing to it anyway would risk an OVERWRITE (not a creation),
    // silently keeping the stale file's permissions, which the subsequent
    // mv would then promote onto the real credential. Aborting before the
    // write is what prevents that (caught in review).
    const { host, byId } = makeFakeHost((_state, args) => {
      if (args.cmd === 'rm') return { exitCode: 1, stdout: '', stderr: 'rm: permission denied' };
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const handle = await host.provision({ name: 'branch-sprite', substrate: { kind: 'sprite' }, options: {} });
    await handle.writeFiles([{ path: '/home/sprite/.claude/.credentials.json', content: 'still-valid-token', mode: 0o600 }]);

    const rootHandle = makeRootHandle({ '/home/sprite/.claude/.credentials.json': 'refreshed-token' });
    await propagateClaudeCredential({
      machineId: TERMINAL_ID,
      branchHandle: handle,
      resolveRootMachineHandle: async () => rootHandle,
    });

    const state = byId.get(handle.machineId);
    // Never reached writeFiles/mv for the temp path — the existing valid
    // credential at the real path must be untouched.
    expect(state?.files.get('/home/sprite/.claude/.credentials.json')).toBe('still-valid-token');
    expect(state?.execLog.some((c) => c.cmd === 'mv')).toBe(false);
  });

  it('given the mv exec throws (e.g. a transport failure), should not fail the spawn (best-effort)', async () => {
    const { host } = makeFakeHost((_state, args) => {
      if (args.cmd === 'mv') throw new Error('exec transport failure');
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const rootHandle = makeRootHandle({ '/home/sprite/.claude/.credentials.json': 'secret-token' });
    const { deps } = makeDeps({ host, resolveRootMachineHandle: async () => rootHandle });

    const result = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    expect(result.ok).toBe(true);
  });

  it('given resolveRootMachineHandle never settles (e.g. a stuck root Sprite), should still return once the bound elapses rather than hanging indefinitely', async () => {
    vi.useFakeTimers();
    try {
      const { host } = makeFakeHost();
      const { deps } = makeDeps({
        host,
        resolveRootMachineHandle: () => new Promise<MachineHandle | null>(() => {}),
      });

      const pending = spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;

      expect(result.ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // ---------------------------------------------------------------------------
  // Concurrency safety: the row MUST be persisted before the credential copy's
  // extra I/O runs — see review (chatgpt-codex-connector, P2). Doing the copy
  // first would widen the window between "clone succeeded" and "row
  // persisted", during which a concurrent racer's `reconcileProvisionCollision`
  // (running because ITS OWN clone failed against this same shared,
  // name-keyed Sprite) would find no matching row yet, conclude the shared
  // Sprite is its own redundant one, and kill it out from under the winner —
  // which is still mid-copy and about to persist that exact sandboxId.
  // ---------------------------------------------------------------------------

  it('given a brand-new branch, should persist the row BEFORE copying the credential (not after)', async () => {
    const { host } = makeFakeHost();
    let sawRowAtCopyTime: unknown;
    const { deps, store } = makeDeps({
      host,
      resolveRootMachineHandle: async (mid) => {
        // If the row isn't there yet when the copy starts, a concurrent
        // racer's reconcile step could kill this call's freshly-provisioned
        // Sprite before it ever gets to persist its own row.
        sawRowAtCopyTime = await store.findByName(mid, PROJECT_NAME, 'main');
        return null;
      },
    });

    const result = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    expect(result.ok).toBe(true);
    expect(sawRowAtCopyTime).toMatchObject({ branchName: 'main', projectName: PROJECT_NAME });
  });

  it('given a re-provision of a vanished branch, should persist the updated sandboxId BEFORE copying the credential (not after)', async () => {
    const { host } = makeFakeHost();
    const { deps, store } = makeDeps({ host, resolveRootMachineHandle: async () => null });

    const first = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    if (!first.ok) throw new Error('expected ok');
    await host.kill({ machineId: first.sandboxId });

    let sawSandboxIdAtCopyTime: string | undefined;
    const deps2: MachineBranchesDeps = {
      ...deps,
      resolveRootMachineHandle: async (mid) => {
        const row = await store.findByName(mid, PROJECT_NAME, 'main');
        sawSandboxIdAtCopyTime = row?.sandboxId;
        return null;
      },
    };

    const second = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps: deps2 });
    expect(second).toMatchObject({ ok: true, resumed: false });
    if (!second.ok) throw new Error('expected ok');
    expect(sawSandboxIdAtCopyTime).toBe(second.sandboxId);
  });
});

describe('killBranch', () => {
  it('given the free text the branch was CREATED with, should normalize the lookup and still kill it', async () => {
    // Whatever text created a branch must also be able to kill it — addProject
    // /spawnBranch persist the CANONICAL name, so a raw-name lookup would 404.
    const { host, killCalls } = makeFakeHost();
    const { deps, store } = makeDeps({ host });
    const spawned = await spawnBranch({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: 'My Cool Feature',
      actor,
      deps,
    });
    if (!spawned.ok) throw new Error('expected ok');

    const result = await killBranch({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: 'My Cool Feature',
      store,
      host,
    });

    expect(result).toEqual({ ok: true });
    expect(killCalls).toContain(spawned.sandboxId);
    expect(await store.findByName(TERMINAL_ID, PROJECT_NAME, 'my-cool-feature')).toBeNull();
  });

  it('given an existing branch, should DELETE its Sprite through the MachineHost seam and drop the tracking row', async () => {
    const { host, killCalls } = makeFakeHost();
    const { deps, store } = makeDeps({ host });
    const spawned = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    if (!spawned.ok) throw new Error('expected ok');

    const result = await killBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', store, host });
    expect(result).toEqual({ ok: true });
    expect(killCalls).toContain(spawned.sandboxId);
    expect(await store.findByName(TERMINAL_ID, PROJECT_NAME, 'main')).toBeNull();
  });

  it('given no such tracked branch, should return not_found without touching the host', async () => {
    const { host, killCalls } = makeFakeHost();
    const { store } = makeDeps({ host });
    const result = await killBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'nope', store, host });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(killCalls).toHaveLength(0);
  });

  it('given the Sprite is unreachable, should keep the tracking row so a retry can still find it (no orphans)', async () => {
    const { host } = makeFakeHost();
    const { deps, store } = makeDeps({ host });
    const spawned = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    if (!spawned.ok) throw new Error('expected ok');

    const failingHost: MachineHost = {
      ...host,
      kill: async () => {
        throw new Error('unreachable');
      },
    };

    const result = await killBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', store, host: failingHost });
    expect(result).toEqual({ ok: false, reason: 'error' });
    expect(await store.findByName(TERMINAL_ID, PROJECT_NAME, 'main')).not.toBeNull();
  });
});

describe('listBranches', () => {
  it('given branches tracked on a project, should list only that project\'s branches', async () => {
    const { host } = makeFakeHost();
    const { deps, store } = makeDeps({ host });
    await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    await spawnBranch({
      machineId: TERMINAL_ID,
      projectName: 'other-repo',
      branchName: 'main',
      actor,
      deps: { ...deps, projectStore: makeProjectStore(REPO_URL) },
    });

    const result = await listBranches({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, store });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ branchName: 'main', projectName: PROJECT_NAME });
  });
});

describe('branch-Sprite storage measurement seam (issue #2204 phase 3)', () => {
  /** Collects seam calls without their handle, which is the fake Sprite object. */
  function makeMeasureSeam() {
    const calls: Array<{ machineBranchId: string; machinePageId: string; hasHandle: boolean }> = [];
    const measureBranchStorage = async (input: BranchStorageMeasurement) => {
      calls.push({
        machineBranchId: input.machineBranchId,
        machinePageId: input.machinePageId,
        hasHandle: typeof input.handle?.exec === 'function',
      });
    };
    return { calls, measureBranchStorage };
  }

  it('given a freshly spawned branch, should measure the branch row and attribute it to the OWNING machine page', async () => {
    const { calls, measureBranchStorage } = makeMeasureSeam();
    const { deps, store } = makeDeps({ measureBranchStorage });

    const result = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    expect(result.ok).toBe(true);
    const row = await store.findByName(TERMINAL_ID, PROJECT_NAME, 'main');

    // Measured against its OWN row, while it is still awake, keyed to the
    // owning Machine page — the attribution key the reconcile bills on.
    expect(calls).toEqual([{ machineBranchId: row?.id, machinePageId: TERMINAL_ID, hasHandle: true }]);
  });

  it('given a reattach of an existing branch, should measure again (footprints change between sessions)', async () => {
    const { calls, measureBranchStorage } = makeMeasureSeam();
    const { deps } = makeDeps({ measureBranchStorage });

    await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    const resumed = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });

    expect(resumed).toMatchObject({ ok: true, resumed: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ machinePageId: TERMINAL_ID, hasHandle: true });
  });

  it('given attachBranch, should measure the attached branch Sprite', async () => {
    const { calls, measureBranchStorage } = makeMeasureSeam();
    const { deps, store, host } = makeDeps({ measureBranchStorage });
    await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    calls.length = 0;

    const attached = await attachBranch({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: 'main',
      store,
      host,
      resolveRootMachineHandle: async () => null,
      measureBranchStorage,
    });

    expect(attached.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ machinePageId: TERMINAL_ID, hasHandle: true });
  });

  it('given a measurement seam that rejects, should NOT fail the spawn (best-effort billing telemetry)', async () => {
    const { deps } = makeDeps({ measureBranchStorage: async () => { throw new Error('db down'); } });

    const result = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });

    // Billing telemetry is best-effort: it must never fail a user-facing spawn.
    expect(result.ok).toBe(true);
  });

  it('given no measurement seam wired, should spawn exactly as before (fully optional)', async () => {
    const { deps } = makeDeps();
    const result = await spawnBranch({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: 'main', actor, deps });
    expect(result).toMatchObject({ ok: true, resumed: false });
  });
});
