/**
 * The local-environment identity flow, end to end against the fake store:
 * create (env + sibling + one-time code, atomically) → enroll (code + public
 * key → pinned key, code consumed) → challenge (nonce) → redeem (signature →
 * token). Every cryptographic and clock primitive is injected; the pure gates
 * (`enrollment.ts`, `challenge.ts`) have their own adversarial matrices, so
 * what this suite pins is the ORDERING and the STATE each step leaves behind.
 */
import { describe, it, expect } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, sign as nodeSign, verify as nodeVerify, createPublicKey } from 'node:crypto';
import {
  createDriveEnv,
  enrollLocalDriveEnv,
  issueLocalEnvChallenge,
  redeemLocalEnvChallenge,
  deriveLocalEnvStatus,
  LOCAL_ENV_HEARTBEAT_WINDOW_MS,
  type LocalEnvIdentityDeps,
} from '../drive-envs';
import { encodeChallenge } from '../../../env-bridge/challenge';
import { ENV_BRIDGE_SCOPE, ENV_BRIDGE_TOKEN_TTL_MS } from '../../../auth/token-lifecycle-policy';
import { makeDriveEnvStore, DRIVE_ID, PAYER_ID, NOW } from './fakes';

const machine = generateKeyPairSync('ed25519');
const rogue = generateKeyPairSync('ed25519');
const server = generateKeyPairSync('ed25519');
const machineSpki = machine.publicKey.export({ type: 'spki', format: 'der' });
const machinePublicKey = machineSpki.toString('base64');

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
  signingKey: { keyId: 'srv-k1', publicKey: new Uint8Array(server.publicKey.export({ type: 'spki', format: 'der' })) },
};

const resolvePayer = async () => ({ payerId: PAYER_ID, tier: 'pro' as const });

function harness(now: Date = NOW) {
  const fake = makeDriveEnvStore([], () => now);
  const minted: Array<{ type: string; scopes: string[]; ttlMs: number; claims: Record<string, string> }> = [];
  const deps = {
    store: fake.store,
    resolvePayer,
    now: () => now,
    identity,
    mintToken: async (policy: { type: string; scopes: string[]; ttlMs: number; claims: Record<string, string> }) => {
      minted.push(policy);
      return `tok_${minted.length}`;
    },
  };
  return { fake, deps, minted };
}

async function createLocal(h: ReturnType<typeof harness>) {
  const result = await createDriveEnv({ driveId: DRIVE_ID, name: 'mac', createdBy: 'user-1', local: { label: 'jono-macstudio', ownerId: 'user-1' }, deps: h.deps });
  if (!result.ok || !result.enrollment) throw new Error(`create failed: ${JSON.stringify(result)}`);
  return { env: result.env, enrollment: result.enrollment };
}

async function enroll(h: ReturnType<typeof harness>, code: string, publicKey = machinePublicKey) {
  return enrollLocalDriveEnv({ enrollmentId: 'enr-1', code, machinePublicKey: publicKey, deps: h.deps });
}

function signChallenge(privateKey: typeof machine.privateKey, nonce: string, exp: number) {
  return Buffer.from(nodeSign(null, encodeChallenge({ nonce, enrollmentId: 'enr-1', exp }), privateKey)).toString('base64');
}

describe('createDriveEnv with local facts — env + sibling + one-time code in ONE step', () => {
  it('given a local request, should mint a substrate:local env, its sibling (label, owner, code hash, expiry) and return the code ONCE', async () => {
    const h = harness();
    const { env, enrollment } = await createLocal(h);
    expect(env.substrate).toBe('local');
    expect(env.sandboxId).toBeNull();
    const sibling = h.fake.local.get(env.id);
    expect(sibling).toMatchObject({ label: 'jono-macstudio', ownerId: 'user-1', enrollmentId: 'enr-1', enrolledAt: null, machinePublicKey: null });
    expect(enrollment.enrollmentId).toBe('enr-1');
    expect(enrollment.code).toHaveLength(20);
    expect(enrollment.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
    // The code is never stored — only its hash.
    expect(sibling?.enrollmentCodeHash).toBe(identity.hash(new TextEncoder().encode(enrollment.code)));
    expect(JSON.stringify(sibling)).not.toContain(enrollment.code);
  });

  it('given a Sprite request (no local facts), should behave exactly as before and return no enrollment', async () => {
    const h = harness();
    const result = await createDriveEnv({ driveId: DRIVE_ID, name: 'dev', createdBy: 'user-1', deps: h.deps });
    expect(result.ok && result.env.substrate).toBe('sprite');
    expect(result.ok && result.enrollment).toBeUndefined();
    expect(h.fake.local.size).toBe(0);
  });

  it('should meter a local env against the same per-payer ceiling as a Sprite env (an env is an env)', async () => {
    const h = harness();
    h.fake.ownedEnvs.set(PAYER_ID, 1_000);
    const result = await createDriveEnv({ driveId: DRIVE_ID, name: 'mac', createdBy: 'user-1', local: { label: 'm', ownerId: 'user-1' }, deps: h.deps });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('quota_exceeded');
    expect(h.fake.local.size).toBe(0);
  });
});

describe('enrollLocalDriveEnv — the machine presents the code and its public key', () => {
  it('given the right code before expiry and a valid Ed25519 SPKI key, should pin key + fingerprint + server keyId, consume the code, and hand back the server public key to pin', async () => {
    const h = harness();
    const { env, enrollment } = await createLocal(h);
    const result = await enroll(h, enrollment.code);
    expect(result).toEqual({
      ok: true,
      envId: env.id,
      enrollmentId: 'enr-1',
      serverKeyId: 'srv-k1',
      serverPublicKey: Buffer.from(identity.signingKey.publicKey).toString('base64'),
    });
    const sibling = h.fake.local.get(env.id)!;
    expect(sibling.machinePublicKey).toBe(machinePublicKey);
    expect(sibling.machineKeyFingerprint).toBe(identity.fingerprint(new Uint8Array(machineSpki)));
    expect(sibling.serverKeyId).toBe('srv-k1');
    expect(sibling.enrolledAt).toEqual(NOW);
    expect(sibling.enrollmentCodeUsedAt).toEqual(NOW);
    expect(sibling.enrollmentCodeHash).toBeNull();
  });

  it('given a second presentation of the same code, should refuse with used and change nothing', async () => {
    const h = harness();
    const { env, enrollment } = await createLocal(h);
    await enroll(h, enrollment.code);
    const before = h.fake.local.get(env.id);
    expect(await enroll(h, enrollment.code, rogue.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'))).toEqual({ ok: false, reason: 'used' });
    expect(h.fake.local.get(env.id)).toEqual(before);
  });

  it('given a wrong code, should refuse with mismatch and pin nothing', async () => {
    const h = harness();
    const { env } = await createLocal(h);
    expect(await enroll(h, 'AAAAAAAAAAAAAAAAAAAA')).toEqual({ ok: false, reason: 'mismatch' });
    expect(h.fake.local.get(env.id)?.machinePublicKey).toBeNull();
  });

  it('given the code after its expiry, should refuse with expired', async () => {
    const h = harness();
    const { enrollment } = await createLocal(h);
    h.deps.now = () => new Date(enrollment.expiresAt.getTime() + 1);
    expect(await enroll(h, enrollment.code)).toEqual({ ok: false, reason: 'expired' });
  });

  it('given a public key that is not a well-formed Ed25519 SPKI, should refuse with bad_public_key BEFORE consuming the code', async () => {
    const h = harness();
    const { env, enrollment } = await createLocal(h);
    expect(await enroll(h, enrollment.code, 'not-base64!!')).toEqual({ ok: false, reason: 'bad_public_key' });
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    expect(await enroll(h, enrollment.code, rsa)).toEqual({ ok: false, reason: 'bad_public_key' });
    expect(h.fake.local.get(env.id)?.enrollmentCodeUsedAt).toBeNull();
    // The code still works afterwards.
    expect((await enroll(h, enrollment.code)).ok).toBe(true);
  });

  it('given an unknown enrollmentId, should refuse with not_found', async () => {
    const h = harness();
    expect(await enrollLocalDriveEnv({ enrollmentId: 'enr-nope', code: 'x', machinePublicKey, deps: h.deps })).toEqual({ ok: false, reason: 'not_found' });
  });

  it('given the store\'s compare-and-set loses (a concurrent enrollment landed between the read and the write), should report race — never claim success', async () => {
    const h = harness();
    const { enrollment } = await createLocal(h);
    const store = { ...h.deps.store, pinMachineKey: async () => false };
    expect(await enrollLocalDriveEnv({ enrollmentId: 'enr-1', code: enrollment.code, machinePublicKey, deps: { ...h.deps, store } })).toEqual({ ok: false, reason: 'race' });
  });

  it('given a revoked enrollment, should refuse with revoked even with the right code', async () => {
    const h = harness();
    const { env, enrollment } = await createLocal(h);
    h.fake.local.set(env.id, { ...h.fake.local.get(env.id)!, revokedAt: NOW });
    expect(await enroll(h, enrollment.code)).toEqual({ ok: false, reason: 'revoked' });
  });
});

describe('issueLocalEnvChallenge / redeemLocalEnvChallenge — proof of possession mints the socket token', () => {
  async function enrolled(h: ReturnType<typeof harness>) {
    const { env, enrollment } = await createLocal(h);
    const result = await enroll(h, enrollment.code);
    if (!result.ok) throw new Error(result.reason);
    return env;
  }

  it('given an enrolled machine, should issue a nonce bound to the enrollment with a short expiry, replacing any previous one', async () => {
    const h = harness();
    const env = await enrolled(h);
    const first = await issueLocalEnvChallenge({ enrollmentId: 'enr-1', deps: h.deps });
    const second = await issueLocalEnvChallenge({ enrollmentId: 'enr-1', deps: h.deps });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.nonce).not.toBe(first.nonce);
    expect(h.fake.local.get(env.id)?.challengeNonce).toBe(second.nonce);
    expect(second.expiresAt.getTime() - NOW.getTime()).toBeLessThanOrEqual(60_000);
  });

  it('given a machine that has not enrolled yet, should refuse with not_enrolled', async () => {
    const h = harness();
    await createLocal(h);
    expect(await issueLocalEnvChallenge({ enrollmentId: 'enr-1', deps: h.deps })).toEqual({ ok: false, reason: 'not_enrolled' });
  });

  it('given the nonce signed by the enrolled key, should mint an env:bridge token bound to the env + enrollment, consume the nonce, and stamp lastSeenAt', async () => {
    const h = harness();
    const env = await enrolled(h);
    const challenge = await issueLocalEnvChallenge({ enrollmentId: 'enr-1', deps: h.deps });
    if (!challenge.ok) throw new Error(challenge.reason);
    const result = await redeemLocalEnvChallenge({
      enrollmentId: 'enr-1',
      response: { enrollmentId: 'enr-1', nonce: challenge.nonce, signature: signChallenge(machine.privateKey, challenge.nonce, challenge.expiresAt.getTime()) },
      deps: h.deps,
    });
    expect(result).toEqual({ ok: true, token: 'tok_1', expiresInMs: ENV_BRIDGE_TOKEN_TTL_MS, envId: env.id });
    expect(h.minted).toEqual([{ type: 'mcp', scopes: [ENV_BRIDGE_SCOPE], ttlMs: ENV_BRIDGE_TOKEN_TTL_MS, claims: { envId: env.id, enrollmentId: 'enr-1' } }]);
    const sibling = h.fake.local.get(env.id)!;
    expect(sibling.challengeUsedAt).toEqual(NOW);
    expect(sibling.lastSeenAt).toEqual(NOW);
  });

  it('given the same signed nonce presented twice, should mint ONCE — the replay is refused as used and nothing is minted', async () => {
    const h = harness();
    await enrolled(h);
    const challenge = await issueLocalEnvChallenge({ enrollmentId: 'enr-1', deps: h.deps });
    if (!challenge.ok) throw new Error(challenge.reason);
    const response = { enrollmentId: 'enr-1', nonce: challenge.nonce, signature: signChallenge(machine.privateKey, challenge.nonce, challenge.expiresAt.getTime()) };
    expect((await redeemLocalEnvChallenge({ enrollmentId: 'enr-1', response, deps: h.deps })).ok).toBe(true);
    expect(await redeemLocalEnvChallenge({ enrollmentId: 'enr-1', response, deps: h.deps })).toEqual({ ok: false, reason: 'used' });
    expect(h.minted).toHaveLength(1);
  });

  it('given a signature from a key other than the pinned one, should refuse with bad_signature, mint nothing, and leave the nonce unconsumed', async () => {
    const h = harness();
    const env = await enrolled(h);
    const challenge = await issueLocalEnvChallenge({ enrollmentId: 'enr-1', deps: h.deps });
    if (!challenge.ok) throw new Error(challenge.reason);
    const result = await redeemLocalEnvChallenge({
      enrollmentId: 'enr-1',
      response: { enrollmentId: 'enr-1', nonce: challenge.nonce, signature: signChallenge(rogue.privateKey, challenge.nonce, challenge.expiresAt.getTime()) },
      deps: h.deps,
    });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
    expect(h.minted).toHaveLength(0);
    expect(h.fake.local.get(env.id)?.challengeUsedAt).toBeNull();
  });

  it('given the nonce compare-and-set loses (another replica redeemed it first), should report race and mint NOTHING', async () => {
    const h = harness();
    await enrolled(h);
    const challenge = await issueLocalEnvChallenge({ enrollmentId: 'enr-1', deps: h.deps });
    if (!challenge.ok) throw new Error(challenge.reason);
    const store = { ...h.deps.store, consumeChallenge: async () => false };
    const result = await redeemLocalEnvChallenge({
      enrollmentId: 'enr-1',
      response: { enrollmentId: 'enr-1', nonce: challenge.nonce, signature: signChallenge(machine.privateKey, challenge.nonce, challenge.expiresAt.getTime()) },
      deps: { ...h.deps, store },
    });
    expect(result).toEqual({ ok: false, reason: 'race' });
    expect(h.minted).toHaveLength(0);
  });

  it('given no outstanding challenge, should refuse with no_challenge', async () => {
    const h = harness();
    await enrolled(h);
    expect(await redeemLocalEnvChallenge({ enrollmentId: 'enr-1', response: { enrollmentId: 'enr-1', nonce: 'n', signature: 'AAAA' }, deps: h.deps })).toEqual({ ok: false, reason: 'no_challenge' });
  });

  it('given a revoked enrollment, should refuse to issue or redeem, even with a valid proof', async () => {
    const h = harness();
    const env = await enrolled(h);
    const challenge = await issueLocalEnvChallenge({ enrollmentId: 'enr-1', deps: h.deps });
    if (!challenge.ok) throw new Error(challenge.reason);
    h.fake.local.set(env.id, { ...h.fake.local.get(env.id)!, revokedAt: NOW });
    expect(await issueLocalEnvChallenge({ enrollmentId: 'enr-1', deps: h.deps })).toEqual({ ok: false, reason: 'revoked' });
    const result = await redeemLocalEnvChallenge({
      enrollmentId: 'enr-1',
      response: { enrollmentId: 'enr-1', nonce: challenge.nonce, signature: signChallenge(machine.privateKey, challenge.nonce, challenge.expiresAt.getTime()) },
      deps: h.deps,
    });
    expect(result).toEqual({ ok: false, reason: 'revoked' });
    expect(h.minted).toHaveLength(0);
  });
});

describe('deriveLocalEnvStatus — a reading of the row plus the live registry, never stored', () => {
  const now = NOW.getTime();
  it('given a live socket, should be connected (or connecting while mid-handshake) regardless of lastSeenAt', () => {
    expect(deriveLocalEnvStatus({ enrolledAt: NOW, revokedAt: null, lastSeenAt: null, liveConnection: 'connected', now })).toBe('connected');
    expect(deriveLocalEnvStatus({ enrolledAt: NOW, revokedAt: null, lastSeenAt: null, liveConnection: 'connecting', now })).toBe('connecting');
  });

  it('given no live socket but a heartbeat inside the window (another replica holds the socket), should be connected', () => {
    expect(deriveLocalEnvStatus({ enrolledAt: NOW, revokedAt: null, lastSeenAt: new Date(now - LOCAL_ENV_HEARTBEAT_WINDOW_MS + 1), liveConnection: null, now })).toBe('connected');
    expect(deriveLocalEnvStatus({ enrolledAt: NOW, revokedAt: null, lastSeenAt: new Date(now - LOCAL_ENV_HEARTBEAT_WINDOW_MS - 1), liveConnection: null, now })).toBe('disconnected');
  });

  it('given a row that never enrolled, or was revoked, should be disconnected even with a fresh heartbeat or a live socket', () => {
    expect(deriveLocalEnvStatus({ enrolledAt: null, revokedAt: null, lastSeenAt: NOW, liveConnection: 'connected', now })).toBe('disconnected');
    expect(deriveLocalEnvStatus({ enrolledAt: NOW, revokedAt: NOW, lastSeenAt: NOW, liveConnection: 'connected', now })).toBe('disconnected');
  });
});
