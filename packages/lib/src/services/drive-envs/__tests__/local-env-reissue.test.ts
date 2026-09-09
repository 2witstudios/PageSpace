/**
 * Re-issuing the one-time enrollment code (Local Environments epic, M3).
 *
 * The code hash is written at creation and shown to the user exactly once. A
 * closed dialog, a lost clipboard or a ten-minute expiry used to leave a local
 * env PERMANENTLY unenrollable — a row that could only be deleted and made
 * again. Re-issue closes that gap for a row that has NOT yet enrolled, and
 * nothing else: an enrolled machine's env must never be re-opened to a second
 * key (that would be a takeover), so the store's compare-and-set on
 * `enrolledAt IS NULL AND revokedAt IS NULL` is the whole security claim and
 * the service only chooses the honest typed answer around it.
 */
import { describe, it, expect } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, createPublicKey, verify as nodeVerify } from 'node:crypto';
import {
  createDriveEnv,
  enrollLocalDriveEnv,
  reissueLocalEnvEnrollmentCode,
  type LocalEnvIdentityDeps,
} from '../drive-envs';
import { makeDriveEnvStore, makeEnvRecord, makeLocalRecord, DRIVE_ID, PAYER_ID, NOW } from './fakes';

const machine = generateKeyPairSync('ed25519');
const machinePublicKey = machine.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

const identity: LocalEnvIdentityDeps = {
  random: (length) => new Uint8Array(randomBytes(length)),
  hash: (bytes) => createHash('sha3-256').update(bytes).digest('hex'),
  fingerprint: (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  isEd25519PublicKey: (spki) => {
    try {
      return createPublicKey({ key: Buffer.from(spki), type: 'spki', format: 'der' }).asymmetricKeyType === 'ed25519';
    } catch {
      return false;
    }
  },
  verify: (message, signature, publicKey) =>
    nodeVerify(null, message, createPublicKey({ key: Buffer.from(publicKey), type: 'spki', format: 'der' }), signature),
  newEnrollmentId: () => 'enr-1',
  signingKey: { keyId: 'srv-k1', publicKey: new Uint8Array(32) },
};

function harness(now: Date = NOW) {
  const fake = makeDriveEnvStore([], () => now);
  const deps = { store: fake.store, resolvePayer: async () => ({ payerId: PAYER_ID, tier: 'pro' as const }), now: () => now, identity };
  return { fake, deps };
}

async function createLocal(h: ReturnType<typeof harness>) {
  const result = await createDriveEnv({ driveId: DRIVE_ID, name: 'mac', createdBy: 'user-1', local: { label: 'jono-macstudio', ownerId: 'user-1', serverPolicy: { ops: ['fs_read', 'fs_write'], checkpoint: false } }, deps: h.deps });
  if (!result.ok || !result.enrollment) throw new Error(`create failed: ${JSON.stringify(result)}`);
  return { env: result.env, enrollment: result.enrollment };
}

describe('reissueLocalEnvEnrollmentCode', () => {
  it('given a local env that has not enrolled, should mint a NEW code (replacing hash and expiry), keep the enrollment id, and the OLD code must stop working', async () => {
    const h = harness();
    const { env, enrollment: first } = await createLocal(h);
    const before = h.fake.local.get(env.id)!;

    const later = new Date(NOW.getTime() + 60_000);
    h.deps.now = () => later;
    const result = await reissueLocalEnvEnrollmentCode({ envId: env.id, deps: h.deps });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.enrollment.enrollmentId).toBe(first.enrollmentId);
    expect(result.enrollment.code).not.toBe(first.code);
    expect(result.enrollment.expiresAt.getTime()).toBe(later.getTime() + 10 * 60 * 1000);

    const after = h.fake.local.get(env.id)!;
    expect(after.enrollmentId).toBe(before.enrollmentId);
    expect(after.enrollmentCodeHash).not.toBe(before.enrollmentCodeHash);
    expect(after.enrollmentCodeExpiresAt?.getTime()).toBe(result.enrollment.expiresAt.getTime());
    expect(after.enrolledAt).toBeNull();
    expect(after.machinePublicKey).toBeNull();

    // The superseded code is dead; the new one enrols.
    expect(await enrollLocalDriveEnv({ enrollmentId: 'enr-1', code: first.code, machinePublicKey, deps: h.deps })).toEqual({ ok: false, reason: 'mismatch' });
    const enrolled = await enrollLocalDriveEnv({ enrollmentId: 'enr-1', code: result.enrollment.code, machinePublicKey, deps: h.deps });
    expect(enrolled.ok).toBe(true);
  });

  it('given the first code has EXPIRED, should still re-issue — expiry is the case this exists for', async () => {
    const h = harness();
    const { env, enrollment: first } = await createLocal(h);
    const afterExpiry = new Date(first.expiresAt.getTime() + 1);
    h.deps.now = () => afterExpiry;
    expect(await enrollLocalDriveEnv({ enrollmentId: 'enr-1', code: first.code, machinePublicKey, deps: h.deps })).toEqual({ ok: false, reason: 'expired' });
    const result = await reissueLocalEnvEnrollmentCode({ envId: env.id, deps: h.deps });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await enrollLocalDriveEnv({ enrollmentId: 'enr-1', code: result.enrollment.code, machinePublicKey, deps: h.deps })).ok).toBe(true);
  });

  it('given the machine has ALREADY ENROLLED, should refuse as already_enrolled and change NOTHING — re-opening an enrolled env would be a takeover', async () => {
    const h = harness();
    const { env, enrollment } = await createLocal(h);
    expect((await enrollLocalDriveEnv({ enrollmentId: 'enr-1', code: enrollment.code, machinePublicKey, deps: h.deps })).ok).toBe(true);
    const before = h.fake.local.get(env.id)!;

    const result = await reissueLocalEnvEnrollmentCode({ envId: env.id, deps: h.deps });
    expect(result).toEqual({ ok: false, reason: 'already_enrolled' });
    expect(h.fake.local.get(env.id)).toEqual(before);
  });

  it('given a REVOKED enrollment (enrolled or not), should refuse as revoked and change nothing', async () => {
    const h = harness();
    const { env } = await createLocal(h);
    await h.fake.store.revokeLocal({ envId: env.id, now: NOW });
    const before = h.fake.local.get(env.id)!;
    expect(await reissueLocalEnvEnrollmentCode({ envId: env.id, deps: h.deps })).toEqual({ ok: false, reason: 'revoked' });
    expect(h.fake.local.get(env.id)).toEqual(before);
  });

  it('given an env with no drive_env_local sibling (a Sprite env, or a local env whose owner was erased), should refuse as not_found', async () => {
    const h = harness();
    h.fake.rows.set('env-s', makeEnvRecord({ id: 'env-s', name: 'cloud' }));
    expect(await reissueLocalEnvEnrollmentCode({ envId: 'env-s', deps: h.deps })).toEqual({ ok: false, reason: 'not_found' });
    expect(await reissueLocalEnvEnrollmentCode({ envId: 'env-missing', deps: h.deps })).toEqual({ ok: false, reason: 'not_found' });
  });

  it('given the pre-read says pending but the compare-and-set LOSES (an enrollment landed in between), should re-read and answer already_enrolled — never claim a code it did not store', async () => {
    const h = harness();
    const { env } = await createLocal(h);
    const real = h.fake.store.reissueEnrollmentCode.bind(h.fake.store);
    // The interleaving: the machine enrols between the service's read and its write.
    h.fake.store.reissueEnrollmentCode = async (input) => {
      h.fake.local.set(env.id, makeLocalRecord({ ...h.fake.local.get(env.id)!, enrolledAt: NOW, machinePublicKey: 'pk', machineKeyFingerprint: 'fp', serverKeyId: 'k1', enrollmentCodeUsedAt: NOW, enrollmentCodeHash: null }));
      return real(input);
    };
    expect(await reissueLocalEnvEnrollmentCode({ envId: env.id, deps: h.deps })).toEqual({ ok: false, reason: 'already_enrolled' });
    expect(h.fake.local.get(env.id)!.enrollmentCodeHash).toBeNull();
  });

  it('given an enrollment that verified the OLD code just before a re-issue landed, the pin must LOSE (the code it verified is no longer the stored one) and the NEW code must still enrol (Codex P1 on #2564)', async () => {
    const h = harness();
    const { env, enrollment: first } = await createLocal(h);
    const realPin = h.fake.store.pinMachineKey.bind(h.fake.store);
    let reissued: string | null = null;
    // The interleaving: the daemon's enroll has already verified `first.code`
    // and is about to pin; the owner's re-issue lands in between.
    h.fake.store.pinMachineKey = async (input) => {
      if (reissued === null) {
        const result = await reissueLocalEnvEnrollmentCode({ envId: env.id, deps: h.deps });
        if (!result.ok) throw new Error(result.reason);
        reissued = result.enrollment.code;
      }
      return realPin(input);
    };
    const stale = await enrollLocalDriveEnv({ enrollmentId: 'enr-1', code: first.code, machinePublicKey, deps: h.deps });
    expect(stale).toEqual({ ok: false, reason: 'race' });
    expect(h.fake.local.get(env.id)!.enrolledAt).toBeNull();
    expect(h.fake.local.get(env.id)!.machinePublicKey).toBeNull();
    // The code the owner was just shown is the one that works.
    expect((await enrollLocalDriveEnv({ enrollmentId: 'enr-1', code: reissued!, machinePublicKey, deps: h.deps })).ok).toBe(true);
  });
});

describe('createDriveEnv — serverPolicy is written at mint (GA wave 1)', () => {
  it('given an explicit serverPolicy, should write it onto the sibling in the SAME step as the code hash — never the column default', async () => {
    const h = harness();
    const result = await createDriveEnv({ driveId: DRIVE_ID, name: 'mac', createdBy: 'user-1', local: { label: 'mac', ownerId: 'user-1', serverPolicy: { ops: ['exec'], checkpoint: false } }, deps: h.deps });
    if (!result.ok) throw new Error(result.reason);
    const sibling = h.fake.local.get(result.env.id)!;
    expect(sibling.serverPolicy).toEqual({ ops: ['exec'], checkpoint: false });
    expect(sibling.enrollmentCodeHash).not.toBeNull();
  });
});
