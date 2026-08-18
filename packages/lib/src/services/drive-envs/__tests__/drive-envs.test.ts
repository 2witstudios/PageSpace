import { describe, it, expect, vi } from 'vitest';
import {
  createDriveEnv,
  listDriveEnvs,
  renameDriveEnv,
  deleteDriveEnv,
  rebuildDriveEnv,
  deriveDriveEnvStatus,
  toDriveEnvDTO,
  type CreateDriveEnvDeps,
  type DeleteDriveEnvDeps,
  type RebuildDriveEnvDeps,
} from '../drive-envs';
import { isUniqueViolation } from '../drive-envs-store';
import { driveEnvDtoSchema } from '../../../drive-envs/env-contract';
import { getDriveEnvLimit } from '../../sandbox/quota';
import { SandboxSpriteReplacedError } from '../../sandbox/sandbox-host';
import { DRIVE_ID, ENV_ID, NOW, PAYER_ID, makeDriveEnvStore, makeEnvRecord, makeSpriteHost } from './fakes';

const SANDBOX_ID = 'pgs-env-abc';

function makeCreateDeps(
  store: ReturnType<typeof makeDriveEnvStore>,
  over: Partial<CreateDriveEnvDeps> = {},
): CreateDriveEnvDeps {
  return {
    store: store.store,
    resolvePayer: async () => ({ payerId: PAYER_ID, tier: 'pro' }),
    now: () => NOW,
    ...over,
  };
}

function makeDeleteDeps(
  store: ReturnType<typeof makeDriveEnvStore>,
  host: ReturnType<typeof makeSpriteHost>,
): DeleteDriveEnvDeps {
  return { store: store.store, host: host.host, now: () => NOW };
}

describe('createDriveEnv', () => {
  it('should mint a row WITHOUT provisioning — envs provision lazily, on the first session inside one', async () => {
    const store = makeDriveEnvStore();
    const result = await createDriveEnv({ driveId: DRIVE_ID, name: 'staging', createdBy: 'user-1', deps: makeCreateDeps(store) });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.driveId).toBe(DRIVE_ID);
    expect(result.env.name).toBe('staging');
    expect(result.env.sandboxId).toBeNull();
    expect(result.env.spriteKey).toBeNull();
  });

  it('given a vanished drive, should fail closed rather than meter the request against anybody else', async () => {
    const store = makeDriveEnvStore();
    const countEnvsOwnedBy = vi.spyOn(store.store, 'countEnvsOwnedBy');
    const result = await createDriveEnv({
      driveId: DRIVE_ID,
      name: 'staging',
      createdBy: null,
      deps: makeCreateDeps(store, { resolvePayer: async () => null }),
    });

    expect(result).toEqual({ ok: false, reason: 'drive_not_found' });
    expect(countEnvsOwnedBy).not.toHaveBeenCalled();
  });

  it('given a duplicate name in the drive, should answer name_taken — the unique index resolves concurrent creates', async () => {
    const store = makeDriveEnvStore([makeEnvRecord({ name: 'staging' })]);
    const result = await createDriveEnv({ driveId: DRIVE_ID, name: 'staging', createdBy: null, deps: makeCreateDeps(store) });
    expect(result).toEqual({ ok: false, reason: 'name_taken' });
  });

  it('given the payer is AT their tier ceiling, should refuse before minting a row', async () => {
    const store = makeDriveEnvStore();
    store.ownedEnvs.set(PAYER_ID, getDriveEnvLimit('pro'));
    const result = await createDriveEnv({ driveId: DRIVE_ID, name: 'staging', createdBy: null, deps: makeCreateDeps(store) });

    expect(result).toEqual({ ok: false, reason: 'quota_exceeded', denial: 'env_limit_reached', limit: getDriveEnvLimit('pro') });
    expect(store.rows.size).toBe(0);
  });

  it('given a FREE-tier payer, should refuse as tier_ineligible — envs are a paid-tier feature', async () => {
    const store = makeDriveEnvStore();
    const result = await createDriveEnv({
      driveId: DRIVE_ID,
      name: 'staging',
      createdBy: null,
      deps: makeCreateDeps(store, { resolvePayer: async () => ({ payerId: PAYER_ID, tier: 'free' }) }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result).toMatchObject({ reason: 'quota_exceeded', denial: 'tier_ineligible' });
    expect(store.rows.size).toBe(0);
  });

  it('given the pre-check passed but the payer hit the ceiling first, should still refuse — the STRUCTURAL check is the real one', async () => {
    // The race Codex named: two admins create differently-NAMED envs for one
    // payer at the ceiling. `(driveId, name)` uniqueness cannot serialize them,
    // and both advisory pre-checks read "under". The count-and-insert under the
    // per-payer advisory lock is what actually holds the line, so a create that
    // passed the pre-check must still be refused by the store.
    const store = makeDriveEnvStore();
    const deps = makeCreateDeps(store);
    // Under the ceiling when the pre-check reads...
    store.ownedEnvs.set(PAYER_ID, getDriveEnvLimit('pro') - 1);
    const countEnvsOwnedBy = vi.spyOn(store.store, 'countEnvsOwnedBy').mockImplementation(async (payerId) => {
      // ...and AT it by the time the insert serializes behind the other admin.
      const seen = store.ownedEnvs.get(payerId) ?? 0;
      store.ownedEnvs.set(payerId, getDriveEnvLimit('pro'));
      return seen;
    });

    const result = await createDriveEnv({ driveId: DRIVE_ID, name: 'staging', createdBy: null, deps });

    expect(countEnvsOwnedBy).toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      reason: 'quota_exceeded',
      denial: 'env_limit_reached',
      limit: getDriveEnvLimit('pro'),
    });
    expect(store.rows.size).toBe(0);
  });

  it('should hand the store the payer AND the tier ceiling — the lock is per PAYER, not per drive', async () => {
    // Per-drive serialization would let one payer's two drives race past a
    // ceiling that is defined across every drive they own.
    const store = makeDriveEnvStore();
    const createIfUnderLimit = vi.spyOn(store.store, 'createIfUnderLimit');
    await createDriveEnv({ driveId: DRIVE_ID, name: 'staging', createdBy: null, deps: makeCreateDeps(store) });
    expect(createIfUnderLimit).toHaveBeenCalledWith(
      expect.objectContaining({ payerId: PAYER_ID, maxEnvs: getDriveEnvLimit('pro') }),
    );
  });

  it('should meter the DRIVE OWNER, not the creator — an env is drive-owned and drive-billed', async () => {
    const store = makeDriveEnvStore();
    const countEnvsOwnedBy = vi.spyOn(store.store, 'countEnvsOwnedBy');
    await createDriveEnv({ driveId: DRIVE_ID, name: 'staging', createdBy: 'some-member', deps: makeCreateDeps(store) });
    expect(countEnvsOwnedBy).toHaveBeenCalledWith(PAYER_ID);
  });
});

describe('listDriveEnvs / the DTO', () => {
  it('should serve contract-valid DTOs carrying no Sprite pointer at all', async () => {
    const store = makeDriveEnvStore([
      makeEnvRecord({ id: 'env-a', name: 'dev' }),
      makeEnvRecord({ id: 'env-b', name: 'staging', sandboxId: SANDBOX_ID, spriteInstanceId: 'inst-1' }),
    ]);
    const dtos = await listDriveEnvs({ driveId: DRIVE_ID, deps: { store: store.store } });

    expect(dtos.map((d) => d.name)).toEqual(['dev', 'staging']);
    for (const dto of dtos) expect(driveEnvDtoSchema.parse(dto)).toEqual(dto);
    expect(JSON.stringify(dtos)).not.toContain(SANDBOX_ID);
  });

  it('should report status from the pointer columns, checking the teardown stamp FIRST', () => {
    // A torn-down env KEEPS its sandboxId (a reclaim needs that pointer), so
    // testing the name first would report a destroyed VM as running.
    expect(deriveDriveEnvStatus({ sandboxId: null, spriteTornDownAt: null })).toBe('none');
    expect(deriveDriveEnvStatus({ sandboxId: SANDBOX_ID, spriteTornDownAt: null })).toBe('running');
    expect(deriveDriveEnvStatus({ sandboxId: SANDBOX_ID, spriteTornDownAt: NOW })).toBe('stopped');
  });

  it('should project a stopped env as stopped, never as ended — an env outlives its machine', () => {
    const dto = toDriveEnvDTO(makeEnvRecord({ sandboxId: SANDBOX_ID, spriteTornDownAt: NOW }));
    expect(dto.status).toBe('stopped');
    expect(dto.createdAt).toBe(NOW.toISOString());
  });
});

describe('renameDriveEnv', () => {
  it('should move the name and nothing else — the id, key and filesystem are untouched', async () => {
    const store = makeDriveEnvStore([makeEnvRecord({ spriteKey: 'key-1', sandboxId: SANDBOX_ID })]);
    const result = await renameDriveEnv({ envId: ENV_ID, name: 'prod', deps: { store: store.store, now: () => NOW } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.name).toBe('prod');
    expect(result.env.id).toBe(ENV_ID);
    expect(result.env.spriteKey).toBe('key-1');
    expect(result.env.sandboxId).toBe(SANDBOX_ID);
  });

  it('given the new name is taken in the drive, should refuse — a name is an address', async () => {
    const store = makeDriveEnvStore([makeEnvRecord({ id: 'env-a', name: 'dev' }), makeEnvRecord({ id: 'env-b', name: 'prod' })]);
    const result = await renameDriveEnv({ envId: 'env-a', name: 'prod', deps: { store: store.store, now: () => NOW } });
    expect(result).toEqual({ ok: false, reason: 'name_taken' });
  });

  it('given no such env, should answer not_found', async () => {
    const store = makeDriveEnvStore();
    const result = await renameDriveEnv({ envId: 'nope', name: 'prod', deps: { store: store.store, now: () => NOW } });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('deleteDriveEnv', () => {
  it('given live sessions and no force, should refuse and touch NOTHING', async () => {
    const store = makeDriveEnvStore([makeEnvRecord({ sandboxId: SANDBOX_ID, spriteInstanceId: `inst-${SANDBOX_ID}` })]);
    store.liveSessions.set(ENV_ID, 2);
    const host = makeSpriteHost({ seed: { [SANDBOX_ID]: { instanceId: `inst-${SANDBOX_ID}` } } });

    const result = await deleteDriveEnv({ envId: ENV_ID, force: false, deps: makeDeleteDeps(store, host) });

    expect(result).toEqual({ ok: false, reason: 'live_sessions', liveSessionCount: 2 });
    expect(host.calls.kill).toEqual([]);
    expect(store.calls.deleteIfUnoccupied).toBe(0);
    expect(store.rows.has(ENV_ID)).toBe(true);
  });

  it('given live sessions AND force, should tear the Sprite down and delete the row', async () => {
    const store = makeDriveEnvStore([makeEnvRecord({ sandboxId: SANDBOX_ID, spriteInstanceId: `inst-${SANDBOX_ID}` })]);
    store.liveSessions.set(ENV_ID, 2);
    const host = makeSpriteHost({ seed: { [SANDBOX_ID]: { instanceId: `inst-${SANDBOX_ID}` } } });

    const result = await deleteDriveEnv({ envId: ENV_ID, force: true, deps: makeDeleteDeps(store, host) });

    expect(result).toEqual({ ok: true, spriteTornDown: true });
    expect(host.live.has(SANDBOX_ID)).toBe(false);
    expect(store.rows.has(ENV_ID)).toBe(false);
  });

  it('should record the teardown INTENT before the kill — a crash in between must stay reclaimable', async () => {
    const order: string[] = [];
    const store = makeDriveEnvStore([makeEnvRecord({ sandboxId: SANDBOX_ID, spriteInstanceId: `inst-${SANDBOX_ID}` })]);
    const host = makeSpriteHost({ seed: { [SANDBOX_ID]: { instanceId: `inst-${SANDBOX_ID}` } } });
    const realRequest = store.store.requestTeardown.bind(store.store);
    store.store.requestTeardown = async (input) => {
      order.push('requestTeardown');
      // The stamp must be DURABLE before the kill, not merely called first.
      expect(store.rows.get(ENV_ID)?.teardownRequestedAt).toBeNull();
      await realRequest(input);
      expect(store.rows.get(ENV_ID)?.teardownRequestedAt).toEqual(NOW);
    };
    const realKill = host.host.kill.bind(host.host);
    host.host.kill = async (input) => {
      order.push('kill');
      await realKill(input);
    };
    const realDelete = store.store.deleteIfUnoccupied.bind(store.store);
    store.store.deleteIfUnoccupied = async (deleteInput) => {
      order.push('deleteIfUnoccupied');
      return realDelete(deleteInput);
    };

    await deleteDriveEnv({ envId: ENV_ID, force: false, deps: makeDeleteDeps(store, host) });

    expect(order).toEqual(['requestTeardown', 'kill', 'deleteIfUnoccupied']);
  });

  it('should CAS the kill on the INSTANCE the row records, not just the name', async () => {
    const store = makeDriveEnvStore([makeEnvRecord({ sandboxId: SANDBOX_ID, spriteInstanceId: 'inst-1' })]);
    const host = makeSpriteHost({ seed: { [SANDBOX_ID]: { instanceId: 'inst-1' } } });

    await deleteDriveEnv({ envId: ENV_ID, force: false, deps: makeDeleteDeps(store, host) });

    expect(host.calls.kill).toEqual([{ sandboxId: SANDBOX_ID, expectedInstanceId: 'inst-1' }]);
  });

  it('given the kill FAILS, should abort the delete and leave the row as the reconciler handle', async () => {
    const store = makeDriveEnvStore([makeEnvRecord({ sandboxId: SANDBOX_ID, spriteInstanceId: 'inst-1' })]);
    const host = makeSpriteHost({ seed: { [SANDBOX_ID]: { instanceId: 'inst-1' } }, killError: new Error('control plane down') });

    const result = await deleteDriveEnv({ envId: ENV_ID, force: false, deps: makeDeleteDeps(store, host) });

    expect(result).toMatchObject({ ok: false, reason: 'teardown_failed' });
    expect(store.calls.deleteIfUnoccupied).toBe(0);
    expect(store.rows.has(ENV_ID)).toBe(true);
    // The intent survives, which is what licenses the orphan reconciler to retry.
    expect(store.rows.get(ENV_ID)?.teardownRequestedAt).toEqual(NOW);
  });

  it('given a REPLACEMENT VM already holds the name, should treat the target as gone and finish the delete', async () => {
    const store = makeDriveEnvStore([makeEnvRecord({ sandboxId: SANDBOX_ID, spriteInstanceId: 'inst-1' })]);
    const host = makeSpriteHost({
      seed: { [SANDBOX_ID]: { instanceId: 'inst-1' } },
      killError: new SandboxSpriteReplacedError(SANDBOX_ID, 'inst-1', 'inst-2'),
    });

    const result = await deleteDriveEnv({ envId: ENV_ID, force: false, deps: makeDeleteDeps(store, host) });

    expect(result.ok).toBe(true);
    expect(store.rows.has(ENV_ID)).toBe(false);
  });

  it('given a never-provisioned env, should delete without killing anything', async () => {
    const store = makeDriveEnvStore([makeEnvRecord()]);
    const host = makeSpriteHost();

    const result = await deleteDriveEnv({ envId: ENV_ID, force: false, deps: makeDeleteDeps(store, host) });

    expect(result).toEqual({ ok: true, spriteTornDown: false });
    expect(host.calls.kill).toEqual([]);
    expect(store.rows.has(ENV_ID)).toBe(false);
  });

  it('given an ALREADY torn-down env, should delete without re-killing a confirmed-dead Sprite', async () => {
    const store = makeDriveEnvStore([
      makeEnvRecord({ sandboxId: SANDBOX_ID, spriteInstanceId: 'inst-1', spriteTornDownAt: NOW }),
    ]);
    const host = makeSpriteHost();

    const result = await deleteDriveEnv({ envId: ENV_ID, force: false, deps: makeDeleteDeps(store, host) });

    expect(result).toEqual({ ok: true, spriteTornDown: false });
    expect(host.calls.kill).toEqual([]);
  });

  it('given a CONFIRMED teardown, should enqueue NOTHING — the trigger must not have the cron chase a dead name', async () => {
    const store = makeDriveEnvStore([makeEnvRecord({ sandboxId: SANDBOX_ID, spriteInstanceId: 'inst-1' })]);
    const host = makeSpriteHost({ seed: { [SANDBOX_ID]: { instanceId: 'inst-1' } } });

    await deleteDriveEnv({ envId: ENV_ID, force: false, deps: makeDeleteDeps(store, host) });

    expect(store.reclaims.size).toBe(0);
  });

  it('given a concurrent re-provision won the confirmation CAS, should still delete AND leave the live replacement to the reclaim outbox', async () => {
    // The crash net doing its actual job. Our kill destroyed instance 1; while
    // it ran, another provisioner put a LIVE instance 2 on the row. The
    // confirmation CAS correctly refuses (stamping that VM dead would hide a
    // billing machine forever), so the row goes to DELETE still believing it is
    // live — which is exactly the shape the AFTER DELETE trigger fires on.
    const store = makeDriveEnvStore([makeEnvRecord({ sandboxId: SANDBOX_ID, spriteInstanceId: 'inst-1' })]);
    const host = makeSpriteHost({ seed: { [SANDBOX_ID]: { instanceId: 'inst-1' } } });
    const realKill = host.host.kill.bind(host.host);
    host.host.kill = async (input) => {
      await realKill(input);
      const row = store.rows.get(ENV_ID);
      if (row) store.rows.set(ENV_ID, { ...row, spriteInstanceId: 'inst-2' });
    };

    const result = await deleteDriveEnv({ envId: ENV_ID, force: false, deps: makeDeleteDeps(store, host) });

    expect(result).toEqual({ ok: true, spriteTornDown: false });
    expect(store.rows.has(ENV_ID)).toBe(false);
    expect(store.reclaims.get(SANDBOX_ID)).toBe('inst-2');
  });

  it('given a session binds DURING the teardown, should refuse the delete rather than cascade it away', async () => {
    // The window Codex named: the cheap guard read zero, and by the time the
    // row would be deleted a session is live in the env. `agent_workspaces.envId`
    // is ON DELETE CASCADE, so an unguarded delete here destroys work nobody
    // opted into destroying. The atomic re-guard inside the delete refuses.
    const store = makeDriveEnvStore([makeEnvRecord({ sandboxId: SANDBOX_ID, spriteInstanceId: 'inst-1' })]);
    const host = makeSpriteHost({ seed: { [SANDBOX_ID]: { instanceId: 'inst-1' } } });
    const realKill = host.host.kill.bind(host.host);
    host.host.kill = async (killInput) => {
      await realKill(killInput);
      store.liveSessions.set(ENV_ID, 1);
    };

    const result = await deleteDriveEnv({ envId: ENV_ID, force: false, deps: makeDeleteDeps(store, host) });

    expect(result).toEqual({ ok: false, reason: 'live_sessions', liveSessionCount: 1 });
    // The env survives, machineless — an ordinary `stopped` env the racing
    // session re-provisions on its next ensure. A rebuilt machine is
    // recoverable; a deleted live session's work is not.
    expect(store.rows.has(ENV_ID)).toBe(true);
    expect(store.rows.get(ENV_ID)?.spriteTornDownAt).toEqual(NOW);
  });

  it('given force, should delete even when a session binds during the teardown', async () => {
    // Forcing means the caller was told sessions are live and said destroy them
    // anyway, so the atomic re-guard skips the count — not the lock.
    const store = makeDriveEnvStore([makeEnvRecord({ sandboxId: SANDBOX_ID, spriteInstanceId: 'inst-1' })]);
    const host = makeSpriteHost({ seed: { [SANDBOX_ID]: { instanceId: 'inst-1' } } });
    const realKill = host.host.kill.bind(host.host);
    host.host.kill = async (killInput) => {
      await realKill(killInput);
      store.liveSessions.set(ENV_ID, 1);
    };

    const result = await deleteDriveEnv({ envId: ENV_ID, force: true, deps: makeDeleteDeps(store, host) });

    expect(result).toEqual({ ok: true, spriteTornDown: true });
    expect(store.rows.has(ENV_ID)).toBe(false);
  });

  it('given no such env, should answer not_found', async () => {
    const store = makeDriveEnvStore();
    const result = await deleteDriveEnv({ envId: 'nope', force: false, deps: makeDeleteDeps(store, makeSpriteHost()) });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('isUniqueViolation', () => {
  it('given drizzle\'s WRAPPED error, should recognize the unique violation', () => {
    // `drizzle-orm@0.45.2`'s pg-core rethrows every driver error as
    // `DrizzleQueryError` with the original on `.cause`, so a top-level `.code`
    // test matches nothing that comes back from an insert — and a duplicate
    // environment name escapes as a 500 instead of the 409 the route sends.
    const driverError = Object.assign(new Error('duplicate key value'), { code: '23505' });
    const wrapped = Object.assign(new Error('Failed query: insert into "drive_envs"'), { cause: driverError });
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it('given a BARE driver error, should still recognize it — the shape is a dependency detail', () => {
    expect(isUniqueViolation(Object.assign(new Error('dup'), { code: '23505' }))).toBe(true);
  });

  it('given any other failure, should not claim a name collision', () => {
    const other = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    expect(isUniqueViolation(Object.assign(new Error('Failed query'), { cause: other }))).toBe(false);
    expect(isUniqueViolation(new Error('connection refused'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });

  it('given a CYCLIC cause chain, should terminate', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b') as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(isUniqueViolation(a)).toBe(false);
  });
});

describe('rebuildDriveEnv', () => {
  function makeRebuildDeps(
    store: ReturnType<typeof makeDriveEnvStore>,
    host: ReturnType<typeof makeSpriteHost>,
    over: Partial<RebuildDriveEnvDeps> = {},
  ): RebuildDriveEnvDeps {
    return {
      store: store.store,
      host: host.host,
      // Stands in for the app's binding of `ensureSpriteHolderSandbox`: mints a
      // VM under the env's deterministic name and records it, exactly as the
      // real `create` arm does.
      ensureSandbox: async (row) => {
        const handle = await host.host.provision({ name: SANDBOX_ID, substrate: { kind: 'sprite' }, options: {} });
        await store.store.updateSpriteIdentity({
          envId: row.id,
          previousSandboxId: row.sandboxId,
          spriteKey: SANDBOX_ID,
          sandboxId: handle.sandboxId,
          spriteInstanceId: handle.spriteInstanceId ?? null,
          egressPolicyToken: null,
          stamps: { lastActiveAt: NOW, teardownRequestedAt: null, spriteTornDownAt: null },
          now: NOW,
        });
        return { ok: true, sandboxId: handle.sandboxId, resumed: false };
      },
      now: () => NOW,
      ...over,
    };
  }

  it('should KILL before it re-provisions — a deterministic name would otherwise hand back the same disk', async () => {
    const order: string[] = [];
    const store = makeDriveEnvStore([makeEnvRecord({ sandboxId: SANDBOX_ID, spriteInstanceId: 'inst-1' })]);
    const host = makeSpriteHost({
      seed: { [SANDBOX_ID]: { instanceId: 'inst-1' } },
      nextInstanceId: () => 'inst-2',
    });
    const realKill = host.host.kill.bind(host.host);
    host.host.kill = async (input) => {
      order.push('kill');
      await realKill(input);
    };
    const deps = makeRebuildDeps(store, host);
    const ensure = deps.ensureSandbox;
    deps.ensureSandbox = async (row) => {
      order.push('provision');
      return ensure(row);
    };

    const result = await rebuildDriveEnv({ envId: ENV_ID, deps });

    expect(result).toEqual({ ok: true, sandboxId: SANDBOX_ID });
    expect(order).toEqual(['kill', 'provision']);
    // Same env id, same Sprite name, DIFFERENT VM — that is what a rebuild is.
    expect(store.rows.get(ENV_ID)?.spriteInstanceId).toBe('inst-2');
    expect(store.rows.get(ENV_ID)?.spriteTornDownAt).toBeNull();
  });

  it('given the kill FAILS, should abort and leave the env on the machine it had', async () => {
    const store = makeDriveEnvStore([makeEnvRecord({ sandboxId: SANDBOX_ID, spriteInstanceId: 'inst-1' })]);
    const host = makeSpriteHost({ seed: { [SANDBOX_ID]: { instanceId: 'inst-1' } }, killError: new Error('nope') });
    const deps = makeRebuildDeps(store, host);
    const ensureSandbox = vi.fn(deps.ensureSandbox);
    deps.ensureSandbox = ensureSandbox;

    const result = await rebuildDriveEnv({ envId: ENV_ID, deps });

    expect(result).toMatchObject({ ok: false, reason: 'teardown_failed' });
    expect(ensureSandbox).not.toHaveBeenCalled();
    expect(store.rows.get(ENV_ID)?.spriteInstanceId).toBe('inst-1');
  });

  it('given the confirmation CAS refused, should abort WITHOUT provisioning — a live replacement is not a rebuild', async () => {
    // A concurrent provision put a live instance 2 on the row while our kill
    // ran. Continuing would resume THAT machine and report a rebuild over a
    // filesystem this call never destroyed — the exact lie the
    // kill-before-provision ordering exists to prevent.
    const store = makeDriveEnvStore([makeEnvRecord({ sandboxId: SANDBOX_ID, spriteInstanceId: 'inst-1' })]);
    const host = makeSpriteHost({ seed: { [SANDBOX_ID]: { instanceId: 'inst-1' } } });
    const realKill = host.host.kill.bind(host.host);
    host.host.kill = async (killInput) => {
      await realKill(killInput);
      const row = store.rows.get(ENV_ID);
      if (row) store.rows.set(ENV_ID, { ...row, spriteInstanceId: 'inst-2' });
    };
    const deps = makeRebuildDeps(store, host);
    const ensureSandbox = vi.fn(deps.ensureSandbox);
    deps.ensureSandbox = ensureSandbox;

    const result = await rebuildDriveEnv({ envId: ENV_ID, deps });

    expect(result).toEqual({ ok: false, reason: 'teardown_failed', detail: 'teardown_not_confirmed' });
    expect(ensureSandbox).not.toHaveBeenCalled();
  });

  it('given a never-provisioned env, should just provision — there is nothing to tear down', async () => {
    const store = makeDriveEnvStore([makeEnvRecord()]);
    const host = makeSpriteHost();
    const result = await rebuildDriveEnv({ envId: ENV_ID, deps: makeRebuildDeps(store, host) });

    expect(result).toEqual({ ok: true, sandboxId: SANDBOX_ID });
    expect(host.calls.kill).toEqual([]);
  });

  it('should hand the provisioner the POST-teardown row, not the stale pre-teardown snapshot', async () => {
    const store = makeDriveEnvStore([makeEnvRecord({ sandboxId: SANDBOX_ID, spriteInstanceId: 'inst-1' })]);
    const host = makeSpriteHost({ seed: { [SANDBOX_ID]: { instanceId: 'inst-1' } }, nextInstanceId: () => 'inst-2' });
    const deps = makeRebuildDeps(store, host);
    const seen: Array<Date | null> = [];
    const ensure = deps.ensureSandbox;
    deps.ensureSandbox = async (row) => {
      seen.push(row.spriteTornDownAt);
      return ensure(row);
    };

    await rebuildDriveEnv({ envId: ENV_ID, deps });

    expect(seen).toEqual([NOW]);
  });

  it('given provisioning fails after the kill, should report it and leave the env machineless but intact', async () => {
    const store = makeDriveEnvStore([makeEnvRecord({ sandboxId: SANDBOX_ID, spriteInstanceId: 'inst-1' })]);
    const host = makeSpriteHost({ seed: { [SANDBOX_ID]: { instanceId: 'inst-1' } } });
    const result = await rebuildDriveEnv({
      envId: ENV_ID,
      deps: makeRebuildDeps(store, host, {
        ensureSandbox: async () => ({ ok: false, reason: 'provision_failed', detail: 'no capacity' }),
      }),
    });

    expect(result).toEqual({ ok: false, reason: 'provision_failed', detail: 'no capacity' });
    expect(store.rows.has(ENV_ID)).toBe(true);
    expect(store.rows.get(ENV_ID)?.spriteTornDownAt).toEqual(NOW);
  });

  it('given no such env, should answer not_found', async () => {
    const store = makeDriveEnvStore();
    const result = await rebuildDriveEnv({ envId: 'nope', deps: makeRebuildDeps(store, makeSpriteHost()) });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });
});
