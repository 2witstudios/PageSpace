/**
 * `setLocalEnvServerPolicy` — the OWNER-ONLY write of a local env's server
 * policy ([D-6]: a machine is driven by its owner only; GA wave 1). The
 * decision is the store's compare-and-set on `(envId, ownerId, revokedAt IS
 * NULL)`; the service only chooses the honest typed answer after a lost CAS.
 */
import { describe, it, expect } from 'vitest';
import { createDriveEnv, setLocalEnvServerPolicy, type LocalEnvIdentityDeps } from '../drive-envs';
import { makeDriveEnvStore, DRIVE_ID, PAYER_ID, NOW } from './fakes';

const identity: LocalEnvIdentityDeps = {
  random: (length) => new Uint8Array(length),
  hash: () => 'hash',
  fingerprint: () => 'fp',
  isEd25519PublicKey: () => true,
  verify: () => true,
  newEnrollmentId: () => 'enr-1',
  signingKey: { keyId: 'srv-k1', publicKey: new Uint8Array(32) },
};

async function harness() {
  const fake = makeDriveEnvStore([], () => NOW);
  const deps = { store: fake.store, resolvePayer: async () => ({ payerId: PAYER_ID, tier: 'pro' as const }), now: () => NOW, identity };
  const created = await createDriveEnv({ driveId: DRIVE_ID, name: 'mac', createdBy: 'owner-1', local: { label: 'mac', ownerId: 'owner-1', serverPolicy: { ops: ['fs_read'], checkpoint: false } }, deps });
  if (!created.ok) throw new Error(created.reason);
  const later = new Date(NOW.getTime() + 60_000);
  const set = (requesterId: string, ops: Array<'exec' | 'fs_read' | 'fs_write'>) =>
    setLocalEnvServerPolicy({ envId: created.env.id, requesterId, serverPolicy: { ops, checkpoint: false }, deps: { store: fake.store, now: () => later } });
  return { fake, envId: created.env.id, set, later };
}

describe('setLocalEnvServerPolicy — owner-only, a compare-and-set on the row', () => {
  it('given the env OWNER, should write the policy and stamp updatedAt', async () => {
    const h = await harness();
    expect(await h.set('owner-1', ['fs_read', 'exec'])).toEqual({ ok: true, serverPolicy: { ops: ['fs_read', 'exec'], checkpoint: false } });
    const row = h.fake.local.get(h.envId)!;
    expect(row.serverPolicy).toEqual({ ops: ['fs_read', 'exec'], checkpoint: false });
    expect(row.updatedAt).toEqual(h.later);
  });

  it('given a user who is NOT the owner (a drive admin included — D-6 is about the enrolling human, not a role), should refuse not_owner naming the owner and leave the row untouched', async () => {
    const h = await harness();
    const before = { ...h.fake.local.get(h.envId)! };
    expect(await h.set('admin-2', ['exec'])).toEqual({ ok: false, reason: 'not_owner', ownerId: 'owner-1' });
    expect(h.fake.local.get(h.envId)).toEqual(before);
  });

  it('given a revoked env, should refuse revoked — even for the owner', async () => {
    const h = await harness();
    await h.fake.store.revokeLocal({ envId: h.envId, now: NOW });
    const before = { ...h.fake.local.get(h.envId)! };
    expect(await h.set('owner-1', ['exec'])).toEqual({ ok: false, reason: 'revoked' });
    expect(h.fake.local.get(h.envId)).toEqual(before);
  });

  it('given a NON-owner on a revoked env, should answer revoked, not not_owner — the machine\'s state outranks the actor\'s standing (the bind order\'s rule)', async () => {
    const h = await harness();
    await h.fake.store.revokeLocal({ envId: h.envId, now: NOW });
    expect(await h.set('admin-2', ['exec'])).toEqual({ ok: false, reason: 'revoked' });
  });

  it('given no sibling (a Sprite env, or a dead local env), should refuse not_found', async () => {
    const h = await harness();
    expect(await setLocalEnvServerPolicy({ envId: 'env-missing', requesterId: 'owner-1', serverPolicy: { ops: [], checkpoint: false }, deps: { store: h.fake.store, now: () => NOW } })).toEqual({ ok: false, reason: 'not_found' });
  });

  it('given the owner setting an EMPTY policy, should accept — the owner may switch the machine off without revoking it', async () => {
    const h = await harness();
    expect(await h.set('owner-1', [])).toEqual({ ok: true, serverPolicy: { ops: [], checkpoint: false } });
  });
});
