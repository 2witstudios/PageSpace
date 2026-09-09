/**
 * `setLocalEnvPaused` — Stop and Resume (GA wave 3, leaf 3). Pauses a local
 * environment's GRANTS without deleting it or revoking its key: `decideSign`
 * refuses `paused` while `pausedAt` is set. OWNER-ONLY by the row ([D-6]):
 * the decision is the store's compare-and-set on `(envId, ownerId, revokedAt
 * IS NULL)`; the service only chooses the honest typed answer after a lost
 * CAS. Drive admins keep Delete; they never get Stop.
 */
import { describe, it, expect } from 'vitest';
import { createDriveEnv, setLocalEnvPaused, type LocalEnvIdentityDeps } from '../drive-envs';
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
  const created = await createDriveEnv({ driveId: DRIVE_ID, name: 'mac', createdBy: 'owner-1', local: { label: 'mac', ownerId: 'owner-1', serverPolicy: { ops: ['exec'], checkpoint: false } }, deps });
  if (!created.ok) throw new Error(created.reason);
  const later = new Date(NOW.getTime() + 60_000);
  const set = (requesterId: string, paused: boolean) => setLocalEnvPaused({ envId: created.env.id, requesterId, paused, deps: { store: fake.store, now: () => later } });
  return { fake, envId: created.env.id, set, later };
}

describe('setLocalEnvPaused — owner-only, a compare-and-set on the row', () => {
  it('given the env OWNER, Stop should stamp pausedAt and Resume should clear it — the key, the policy and the row survive both', async () => {
    const h = await harness();
    expect(await h.set('owner-1', true)).toEqual({ ok: true, paused: true });
    let row = h.fake.local.get(h.envId)!;
    expect(row.pausedAt).toEqual(h.later);
    expect(row.revokedAt).toBeNull();
    expect(row.serverPolicy).toEqual({ ops: ['exec'], checkpoint: false });
    expect(await h.set('owner-1', false)).toEqual({ ok: true, paused: false });
    row = h.fake.local.get(h.envId)!;
    expect(row.pausedAt).toBeNull();
    expect(row.updatedAt).toEqual(h.later);
  });

  it('given a user who is NOT the owner (a drive admin included — D-6), should refuse not_owner naming the owner and leave the row untouched', async () => {
    const h = await harness();
    const before = { ...h.fake.local.get(h.envId)! };
    expect(await h.set('admin-2', true)).toEqual({ ok: false, reason: 'not_owner', ownerId: 'owner-1' });
    expect(h.fake.local.get(h.envId)).toEqual(before);
  });

  it('given a revoked env, should refuse revoked — a dead machine cannot be paused or resumed', async () => {
    const h = await harness();
    await h.fake.store.revokeLocal({ envId: h.envId, now: NOW });
    expect(await h.set('owner-1', true)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('given an unknown env, should refuse not_found', async () => {
    const h = await harness();
    expect(await setLocalEnvPaused({ envId: 'env-nope', requesterId: 'owner-1', paused: true, deps: { store: h.fake.store, now: () => NOW } })).toEqual({ ok: false, reason: 'not_found' });
  });

  it('Stop twice is idempotent: the second stamp does not move pausedAt', async () => {
    const h = await harness();
    await h.set('owner-1', true);
    const first = h.fake.local.get(h.envId)!.pausedAt;
    await setLocalEnvPaused({ envId: h.envId, requesterId: 'owner-1', paused: true, deps: { store: h.fake.store, now: () => new Date(NOW.getTime() + 999_000) } });
    expect(h.fake.local.get(h.envId)!.pausedAt).toEqual(first);
  });
});
