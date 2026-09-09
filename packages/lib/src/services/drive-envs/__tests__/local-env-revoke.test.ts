/**
 * Revoke = all three legs (Codex C4): the row stamp, every env:bridge session,
 * the machine's socket. Against the fake store, wired to the REAL enrollment
 * services so "future token mints fail" is pinned through the service, not a
 * fake's flag.
 */
import { describe, it, expect } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, sign as nodeSign, verify as nodeVerify, createPublicKey } from 'node:crypto';
import { createDriveEnv, enrollLocalDriveEnv, issueLocalEnvChallenge, redeemLocalEnvChallenge, type LocalEnvIdentityDeps } from '../drive-envs';
import { revokeLocalDriveEnv, type RevokeLocalDriveEnvDeps, type RevokeMachineNotifyOutcome } from '../local-env-revoke';
import { encodeChallenge } from '../../../env-bridge/challenge';
import { makeDriveEnvStore, DRIVE_ID, PAYER_ID, NOW } from './fakes';

const machine = generateKeyPairSync('ed25519');
const server = generateKeyPairSync('ed25519');
const machinePublicKey = machine.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

const identity: LocalEnvIdentityDeps = {
  random: (length) => new Uint8Array(randomBytes(length)),
  hash: (bytes) => createHash('sha3-256').update(bytes).digest('hex'),
  fingerprint: (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  isEd25519PublicKey: () => true,
  verify: (message, signature, publicKey) => nodeVerify(null, message, createPublicKey({ key: Buffer.from(publicKey), type: 'spki', format: 'der' }), signature),
  newEnrollmentId: () => 'enr-1',
  signingKey: { keyId: 'srv-k1', publicKey: new Uint8Array(server.publicKey.export({ type: 'spki', format: 'der' })) },
};

function harness(machineOutcome: RevokeMachineNotifyOutcome = 'sent_and_closed') {
  const fake = makeDriveEnvStore();
  const order: string[] = [];
  const sessionRevokes: Array<{ envId: string; reason: string }> = [];
  const notifies: Array<Parameters<RevokeLocalDriveEnvDeps['notifyMachine']>[0]> = [];
  const identityDeps = {
    store: fake.store,
    resolvePayer: async () => ({ payerId: PAYER_ID, tier: 'pro' as const }),
    now: () => NOW,
    identity,
    mintToken: async () => {
      order.push('mint');
      return 'tok';
    },
    revokeToken: async () => {
      order.push('revoke_token');
    },
  };
  const revokeDeps: RevokeLocalDriveEnvDeps = {
    store: {
      findLocalByEnvId: fake.store.findLocalByEnvId,
      revokeLocal: async (input) => {
        order.push('stamp');
        return fake.store.revokeLocal(input);
      },
    },
    now: () => NOW,
    revokeSessions: async (input) => {
      order.push('sessions');
      sessionRevokes.push(input);
      return 2;
    },
    notifyMachine: async (input) => {
      order.push('machine');
      notifies.push(input);
      return machineOutcome;
    },
  };
  return { fake, order, sessionRevokes, notifies, identityDeps, revokeDeps };
}

async function enrolledEnv(h: ReturnType<typeof harness>) {
  const created = await createDriveEnv({ driveId: DRIVE_ID, name: 'mac', createdBy: 'user-1', local: { label: 'mac', ownerId: 'user-1', serverPolicy: { ops: ['fs_read', 'fs_write'], checkpoint: false } }, deps: h.identityDeps });
  if (!created.ok || !created.enrollment) throw new Error('create failed');
  const enrolled = await enrollLocalDriveEnv({ enrollmentId: 'enr-1', code: created.enrollment.code, machinePublicKey, deps: h.identityDeps });
  if (!enrolled.ok) throw new Error(`enroll failed: ${enrolled.reason}`);
  return created.env.id;
}

describe('revokeLocalDriveEnv — all three legs, in order', () => {
  it('given an enrolled machine, should stamp revokedAt, revoke its sessions, notify the machine — in that order — and report each', async () => {
    const h = harness();
    const envId = await enrolledEnv(h);
    const result = await revokeLocalDriveEnv({ envId, reason: 'owner_revoked', deps: h.revokeDeps });
    expect(result).toEqual({ ok: true, alreadyRevoked: false, revokedAt: NOW, sessionsRevoked: 2, machine: 'sent_and_closed' });
    expect(h.order).toEqual(['stamp', 'sessions', 'machine']);
    expect(h.sessionRevokes).toEqual([{ envId, reason: 'owner_revoked' }]);
    expect(h.notifies).toEqual([{ envId, enrollmentId: 'enr-1', serverKeyId: 'srv-k1', issuedAt: NOW.getTime(), reason: 'owner_revoked' }]);
    expect(h.fake.local.get(envId)?.revokedAt).toEqual(NOW);
  });

  it('after a revoke, the daemon\'s next token mint should fail: challenge and redeem both answer revoked through the REAL service', async () => {
    const h = harness();
    const envId = await enrolledEnv(h);
    // A challenge issued BEFORE the revoke must not redeem after it either.
    const issued = await issueLocalEnvChallenge({ enrollmentId: 'enr-1', deps: h.identityDeps });
    if (!issued.ok) throw new Error(issued.reason);
    await revokeLocalDriveEnv({ envId, reason: 'owner_revoked', deps: h.revokeDeps });

    const sig = Buffer.from(nodeSign(null, encodeChallenge({ nonce: issued.nonce, enrollmentId: 'enr-1', exp: issued.expiresAt.getTime() }), machine.privateKey)).toString('base64');
    expect(await redeemLocalEnvChallenge({ enrollmentId: 'enr-1', response: { enrollmentId: 'enr-1', nonce: issued.nonce, signature: sig }, deps: h.identityDeps })).toEqual({ ok: false, reason: 'revoked' });
    expect(await issueLocalEnvChallenge({ enrollmentId: 'enr-1', deps: h.identityDeps })).toEqual({ ok: false, reason: 'revoked' });
    expect(h.order).not.toContain('mint');
  });

  it('given a machine already revoked (an earlier attempt crashed between legs), should STILL run legs 2 and 3 and report alreadyRevoked with the ORIGINAL stamp', async () => {
    const h = harness();
    const envId = await enrolledEnv(h);
    const first = new Date(NOW.getTime() - 60_000);
    await h.fake.store.revokeLocal({ envId, now: first });
    const result = await revokeLocalDriveEnv({ envId, reason: 'retry', deps: h.revokeDeps });
    expect(result).toEqual({ ok: true, alreadyRevoked: true, revokedAt: first, sessionsRevoked: 2, machine: 'sent_and_closed' });
    expect(h.order).toEqual(['stamp', 'sessions', 'machine']);
    expect(h.fake.local.get(envId)?.revokedAt).toEqual(first);
  });

  it('given the pinned server key is no longer loaded, should still complete legs 1 and 2 and report the socket closed unsigned (never signed under another key)', async () => {
    const h = harness('closed_unsigned_key_unavailable');
    const envId = await enrolledEnv(h);
    const result = await revokeLocalDriveEnv({ envId, reason: 'owner_revoked', deps: h.revokeDeps });
    expect(result).toMatchObject({ ok: true, machine: 'closed_unsigned_key_unavailable', sessionsRevoked: 2 });
    expect(h.fake.local.get(envId)?.revokedAt).toEqual(NOW);
  });

  it('given no drive_env_local row (a Sprite env, or a deleted one), should answer not_found and touch nothing', async () => {
    const h = harness();
    expect(await revokeLocalDriveEnv({ envId: 'env-nope', reason: 'x', deps: h.revokeDeps })).toEqual({ ok: false, reason: 'not_found' });
    expect(h.order).toEqual([]);
  });

  it('given a machine that never enrolled (pending code), should still revoke: the code can no longer be redeemed', async () => {
    const h = harness('no_live_socket');
    const created = await createDriveEnv({ driveId: DRIVE_ID, name: 'mac', createdBy: 'user-1', local: { label: 'mac', ownerId: 'user-1', serverPolicy: { ops: ['fs_read', 'fs_write'], checkpoint: false } }, deps: h.identityDeps });
    if (!created.ok || !created.enrollment) throw new Error('create failed');
    const result = await revokeLocalDriveEnv({ envId: created.env.id, reason: 'owner_revoked', deps: h.revokeDeps });
    expect(result).toMatchObject({ ok: true, alreadyRevoked: false, machine: 'no_live_socket' });
    expect(await enrollLocalDriveEnv({ enrollmentId: 'enr-1', code: created.enrollment.code, machinePublicKey, deps: h.identityDeps })).toEqual({ ok: false, reason: 'revoked' });
  });
});
