import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify, createPublicKey, randomBytes } from 'node:crypto';
import { issueChallenge, encodeChallenge, verifyChallengeResponse, CHALLENGE_TTL_MS, type Challenge } from '../challenge';
import type { Ed25519Verify } from '../grant';
import type { RandomBytes } from '../enrollment';

// Real Ed25519, INJECTED. The module never imports node:crypto.
const machine = generateKeyPairSync('ed25519');
const rogue = generateKeyPairSync('ed25519');
const machinePublicKey = new Uint8Array(machine.publicKey.export({ type: 'spki', format: 'der' }));

const verify: Ed25519Verify = (message, signature, publicKey) =>
  nodeVerify(null, message, createPublicKey({ key: Buffer.from(publicKey), type: 'spki', format: 'der' }), signature);
const random: RandomBytes = (length) => new Uint8Array(randomBytes(length));

const NOW = 1_800_000_000_000;
const ENROLLMENT = 'enr_1';

function signWith(privateKey: typeof machine.privateKey, challenge: Challenge): string {
  return Buffer.from(nodeSign(null, encodeChallenge(challenge), privateKey)).toString('base64');
}

function challenge(overrides: Partial<Challenge> = {}): Challenge {
  return { ...issueChallenge({ random, now: NOW, enrollmentId: ENROLLMENT }), ...overrides };
}

interface RunOpts {
  response?: unknown;
  signature?: string;
  usedAt?: number | null;
  now?: number;
  key?: Uint8Array;
}

function run(c: Challenge, opts: RunOpts = {}) {
  const signature = opts.signature ?? signWith(machine.privateKey, c);
  // `in`, not `??`: a caller passing `response: null` means a null response.
  const response = 'response' in opts ? opts.response : { enrollmentId: c.enrollmentId, nonce: c.nonce, signature };
  return verifyChallengeResponse({
    challenge: { ...c, usedAt: opts.usedAt ?? null },
    response,
    machinePublicKey: opts.key ?? machinePublicKey,
    verify,
    now: opts.now ?? NOW,
  });
}

describe('issueChallenge — a nonce the machine must sign to prove it holds the private key', () => {
  it('should bind the nonce to the enrollment with iat = now and exp = now + TTL', () => {
    const c = issueChallenge({ random, now: NOW, enrollmentId: ENROLLMENT });
    expect(c.enrollmentId).toBe(ENROLLMENT);
    expect(c.iat).toBe(NOW);
    expect(c.exp).toBe(NOW + CHALLENGE_TTL_MS);
    expect(c.nonce.length).toBeGreaterThanOrEqual(32);
  });

  it('should draw the nonce from the injected randomness only', () => {
    const fixed: RandomBytes = (length) => new Uint8Array(length).fill(7);
    expect(issueChallenge({ random: fixed, now: NOW, enrollmentId: ENROLLMENT }).nonce).toBe(
      issueChallenge({ random: fixed, now: NOW, enrollmentId: ENROLLMENT }).nonce,
    );
  });
});

describe('encodeChallenge — the bytes the machine signs', () => {
  it('should be canonical: fixed key order, independent of the object the caller held', () => {
    const a = encodeChallenge({ nonce: 'n', enrollmentId: 'e', exp: 1 });
    const b = encodeChallenge({ exp: 1, enrollmentId: 'e', nonce: 'n' } as never);
    expect(Buffer.from(a).toString()).toBe(Buffer.from(b).toString());
    expect(Buffer.from(a).toString()).toBe('{"nonce":"n","enrollmentId":"e","exp":1}');
  });
});

describe('verifyChallengeResponse — proof of possession, never a stored secret (invariant 2)', () => {
  it('given the nonce signed by the pinned machine key, unused and unexpired, should return ok', () => {
    expect(run(challenge())).toEqual({ ok: true });
  });

  it('given a signature from ANY other key, should return bad_signature', () => {
    const c = challenge();
    expect(run(c, { signature: signWith(rogue.privateKey, c) })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('given a valid signature over a DIFFERENT nonce, should return nonce_mismatch before touching crypto', () => {
    const c = challenge();
    const other = challenge({ nonce: 'someone-elses-nonce' });
    expect(run(c, { response: { enrollmentId: ENROLLMENT, nonce: other.nonce, signature: signWith(machine.privateKey, other) } })).toEqual({
      ok: false,
      reason: 'nonce_mismatch',
    });
  });

  it('given a response naming another enrollment, should return wrong_enrollment', () => {
    const c = challenge();
    expect(run(c, { response: { enrollmentId: 'enr_other', nonce: c.nonce, signature: signWith(machine.privateKey, c) } })).toEqual({
      ok: false,
      reason: 'wrong_enrollment',
    });
  });

  it('given a nonce already consumed, should return used — a replayed proof mints nothing', () => {
    expect(run(challenge(), { usedAt: NOW - 1 })).toEqual({ ok: false, reason: 'used' });
  });

  it('given a nonce past its expiry, should return expired; exactly at expiry is still good', () => {
    const c = challenge();
    expect(run(c, { now: c.exp + 1 })).toEqual({ ok: false, reason: 'expired' });
    expect(run(c, { now: c.exp })).toEqual({ ok: true });
  });

  it('given a malformed response (missing fields, wrong types, non-base64 signature, extra fields), should return malformed', () => {
    const c = challenge();
    expect(run(c, { response: null })).toEqual({ ok: false, reason: 'malformed' });
    expect(run(c, { response: { enrollmentId: ENROLLMENT, nonce: c.nonce } })).toEqual({ ok: false, reason: 'malformed' });
    expect(run(c, { response: { enrollmentId: ENROLLMENT, nonce: c.nonce, signature: 42 } })).toEqual({ ok: false, reason: 'malformed' });
    expect(run(c, { response: { enrollmentId: ENROLLMENT, nonce: c.nonce, signature: '!!!not base64' } })).toEqual({ ok: false, reason: 'malformed' });
    expect(run(c, { response: { enrollmentId: ENROLLMENT, nonce: c.nonce, signature: signWith(machine.privateKey, c), isAdmin: true } })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('given a signature that verifies against a key that is NOT the pinned one (key swapped server-side), should still return bad_signature', () => {
    const c = challenge();
    const rogueKey = new Uint8Array(rogue.publicKey.export({ type: 'spki', format: 'der' }));
    expect(run(c, { key: rogueKey })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('given a verify primitive that throws, should return bad_signature rather than propagate', () => {
    const c = challenge();
    const verdict = verifyChallengeResponse({
      challenge: { ...c, usedAt: null },
      response: { enrollmentId: c.enrollmentId, nonce: c.nonce, signature: signWith(machine.privateKey, c) },
      machinePublicKey,
      verify: () => {
        throw new Error('boom');
      },
      now: NOW,
    });
    expect(verdict).toEqual({ ok: false, reason: 'bad_signature' });
  });
});
