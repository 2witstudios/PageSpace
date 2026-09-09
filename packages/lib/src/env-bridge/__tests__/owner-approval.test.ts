/**
 * B2 — the WebAuthn challenge is DERIVED from the frozen request, never
 * random, so an assertion cannot be moved to another request, another
 * challenge or another environment; and B4 — the total verifier the daemon
 * runs over the assertion the click carries.
 *
 * Every row here is one of the Given/Should rows on the leaf pages
 * (`zwqrwnun4g2cgx3xu995k4by`, `ihf41c2amxdob7a7vdg0t00c`). The crypto
 * primitives are injected exactly as everywhere else in this folder, so the
 * matrix is exhaustive rather than flaky.
 */
import { describe, expect, it } from 'vitest';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import {
  coseEc2ToJwk,
  deriveOwnerApprovalChallenge,
  OWNER_APPROVAL_DENY_ORDER,
  ownerApprovalRequestHash,
  pendingRequestForWire,
  verifyOwnerApproval,
  type EcJwkPublic,
  type OwnerApprovalRequest,
  type PinnedOwnerApproval,
  type Sha256Bytes,
} from '../owner-approval';
import { HELLO_SIGNING_DOMAIN, OWNER_APPROVAL_SIGNING_DOMAIN, PAUSE_SIGNING_DOMAIN, RESULT_SIGNING_DOMAIN, REVOKE_APPROVAL_SIGNING_DOMAIN, REVOKE_SIGNING_DOMAIN } from '../machine-signatures';
import type { NormalizedRequest } from '../decide-execution';

const sha256: Sha256Bytes = (bytes) => new Uint8Array(createHash('sha256').update(bytes).digest());
const b64url = (bytes: Uint8Array | Buffer): string => Buffer.from(bytes).toString('base64url');

const es256Verify = (message: Uint8Array, signature: Uint8Array, publicKey: EcJwkPublic): boolean => {
  try {
    return nodeVerify('sha256', message, createPublicKey({ key: { ...publicKey }, format: 'jwk' }), signature);
  } catch {
    return false;
  }
};

const REQUEST: OwnerApprovalRequest = {
  op: 'exec',
  cmd: 'git',
  args: ['status'],
  cwd: '/home/jono/project',
  paths: [],
  env: { PATH: '/usr/bin' },
  timeoutMs: 30_000,
  maxBytes: 65_536,
  clamped: false,
};

const ENV_ID = 'env_1';
const CHALLENGE_ID = 'chal_1';

// ---- a real P-256 credential, so the signature rows are not simulated ------

function makeCredential(): { credentialId: string; publicKeyCose: string; sign: (message: Uint8Array) => Uint8Array } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  // COSE_Key: {1: 2, 3: -7, -1: 1, -2: x, -3: y} — a definite-length 5-entry map.
  const cose = Buffer.concat([
    Buffer.from([0xa5]),
    Buffer.from([0x01, 0x02]),
    Buffer.from([0x03, 0x26]),
    Buffer.from([0x20, 0x01]),
    Buffer.from([0x21, 0x58, 0x20]),
    x,
    Buffer.from([0x22, 0x58, 0x20]),
    y,
  ]);
  return {
    credentialId: b64url(Buffer.from('credential-one')),
    publicKeyCose: b64url(cose),
    sign: (message) => new Uint8Array(nodeSign('sha256', message, createPrivateKey(privateKey.export({ format: 'pem', type: 'pkcs8' }) as string))),
  };
}

const CREDENTIAL = makeCredential();
const RP_ID = 'pagespace.app';
const ORIGIN = 'https://pagespace.app';

const PINNED: PinnedOwnerApproval = { rpId: RP_ID, origin: ORIGIN, credentials: [{ credentialId: CREDENTIAL.credentialId, publicKeyCose: CREDENTIAL.publicKeyCose }] };

/** An authenticatorData with the given rpId and flags (UP = 0x01, UV = 0x04). */
function authenticatorData(rpId: string, flags = 0x05): Uint8Array {
  const rpIdHash = sha256(new TextEncoder().encode(rpId));
  const out = new Uint8Array(37);
  out.set(rpIdHash, 0);
  out[32] = flags;
  // signCount 0 in the last four bytes.
  return out;
}

interface AssertionOverrides {
  readonly type?: string;
  readonly challenge?: string;
  readonly origin?: string;
  readonly rpId?: string;
  readonly flags?: number;
  readonly credentialId?: string;
  readonly signWith?: (message: Uint8Array) => Uint8Array;
}

function makeAssertion(overrides: AssertionOverrides = {}) {
  const challenge = overrides.challenge ?? deriveOwnerApprovalChallenge({ envId: ENV_ID, challengeId: CHALLENGE_ID, request: REQUEST }, sha256);
  const clientData = new TextEncoder().encode(JSON.stringify({ type: overrides.type ?? 'webauthn.get', challenge, origin: overrides.origin ?? ORIGIN, crossOrigin: false }));
  const authData = authenticatorData(overrides.rpId ?? RP_ID, overrides.flags ?? 0x05);
  const signed = new Uint8Array(authData.length + 32);
  signed.set(authData, 0);
  signed.set(sha256(clientData), authData.length);
  const signature = (overrides.signWith ?? CREDENTIAL.sign)(signed);
  return {
    credentialId: overrides.credentialId ?? CREDENTIAL.credentialId,
    authenticatorData: b64url(authData),
    clientDataJSON: b64url(clientData),
    signature: b64url(signature),
  };
}

const verify = (assertion: unknown, pinned: PinnedOwnerApproval = PINNED, request: OwnerApprovalRequest = REQUEST, challengeId = CHALLENGE_ID, envId = ENV_ID) =>
  verifyOwnerApproval({ assertion, pinned, envId, challengeId, request, sha256, verifyEs256: es256Verify });

// ---------------------------------------------------------------------------

describe('B2 — the challenge is derived from the frozen request', () => {
  it('both sides derive byte-identical challenges from the same fixture (pure, no clock, no I/O)', () => {
    const a = deriveOwnerApprovalChallenge({ envId: ENV_ID, challengeId: CHALLENGE_ID, request: REQUEST }, sha256);
    const b = deriveOwnerApprovalChallenge({ envId: ENV_ID, challengeId: CHALLENGE_ID, request: { ...REQUEST } }, sha256);
    expect(a).toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('a different challengeId derives a different challenge', () => {
    expect(deriveOwnerApprovalChallenge({ envId: ENV_ID, challengeId: 'chal_2', request: REQUEST }, sha256)).not.toBe(
      deriveOwnerApprovalChallenge({ envId: ENV_ID, challengeId: CHALLENGE_ID, request: REQUEST }, sha256),
    );
  });

  it('a different envId derives a different challenge — an assertion never travels between environments', () => {
    expect(deriveOwnerApprovalChallenge({ envId: 'env_2', challengeId: CHALLENGE_ID, request: REQUEST }, sha256)).not.toBe(
      deriveOwnerApprovalChallenge({ envId: ENV_ID, challengeId: CHALLENGE_ID, request: REQUEST }, sha256),
    );
  });

  it.each<[string, OwnerApprovalRequest]>([
    ['cmd', { ...REQUEST, cmd: 'git ' }],
    ['args', { ...REQUEST, args: ['status', '--short'] }],
    ['args absent vs empty', { ...REQUEST, args: [] }],
    ['cwd', { ...REQUEST, cwd: '/home/jono/project2' }],
    ['paths', { ...REQUEST, paths: ['/home/jono/project/a'] }],
    ['env', { ...REQUEST, env: { PATH: '/usr/bin:' } }],
    ['timeoutMs', { ...REQUEST, timeoutMs: 30_001 }],
    ['maxBytes', { ...REQUEST, maxBytes: 65_537 }],
    ['clamped', { ...REQUEST, clamped: true }],
  ])('a request differing by one byte in %s derives a different challenge', (_field, altered) => {
    expect(deriveOwnerApprovalChallenge({ envId: ENV_ID, challengeId: CHALLENGE_ID, request: altered }, sha256)).not.toBe(
      deriveOwnerApprovalChallenge({ envId: ENV_ID, challengeId: CHALLENGE_ID, request: REQUEST }, sha256),
    );
  });

  it('a request field the wire gains later is covered without touching this module (whole-request hash)', () => {
    const withExtra = { ...REQUEST, writeModes: [0o755] } as unknown as OwnerApprovalRequest;
    expect(ownerApprovalRequestHash(withExtra, sha256)).not.toBe(ownerApprovalRequestHash(REQUEST, sha256));
  });

  it('the domain is distinct from all five existing ones, so an assertion is never replayable as another message', () => {
    const domains = [HELLO_SIGNING_DOMAIN, RESULT_SIGNING_DOMAIN, REVOKE_SIGNING_DOMAIN, REVOKE_APPROVAL_SIGNING_DOMAIN, PAUSE_SIGNING_DOMAIN, OWNER_APPROVAL_SIGNING_DOMAIN];
    expect(new Set(domains).size).toBe(domains.length);
    expect(OWNER_APPROVAL_SIGNING_DOMAIN).toBe('pagespace-env-bridge/owner-approval/v1');
  });

  it('the domain is inside the derivation: a challenge over the same binding without it differs', () => {
    const withDomain = deriveOwnerApprovalChallenge({ envId: ENV_ID, challengeId: CHALLENGE_ID, request: REQUEST }, sha256);
    const requestHash = ownerApprovalRequestHash(REQUEST, sha256);
    const withoutDomain = b64url(sha256(new TextEncoder().encode(JSON.stringify({ challengeId: CHALLENGE_ID, envId: ENV_ID, requestHash }))));
    expect(withDomain).not.toBe(withoutDomain);
  });

  it('pendingRequestForWire projects a NormalizedRequest to exactly the wire shape both sides hash', () => {
    const normalized: NormalizedRequest = { op: 'exec', cmd: 'git', args: ['status'], cwd: '/home/jono/project', paths: [], env: { PATH: '/usr/bin' }, timeoutMs: 30_000, maxBytes: 65_536, clamped: false };
    expect(pendingRequestForWire(normalized)).toEqual(REQUEST);
    // Fresh copies: freezing the normalized request must not freeze the wire one.
    expect(pendingRequestForWire(normalized).paths).not.toBe(normalized.paths);
  });

  it('an fs_write with no cmd/args omits them on both sides identically', () => {
    const normalized: NormalizedRequest = { op: 'fs_write', cwd: '/root', paths: ['/root/a'], env: {}, timeoutMs: 1, maxBytes: 1, clamped: false };
    const wire = pendingRequestForWire(normalized);
    expect('cmd' in wire).toBe(false);
    expect('args' in wire).toBe(false);
    expect(ownerApprovalRequestHash(wire, sha256)).toBe(ownerApprovalRequestHash(JSON.parse(JSON.stringify(wire)) as OwnerApprovalRequest, sha256));
  });
});

describe('B4 — the daemon verifies the assertion itself', () => {
  it('a well-formed assertion over the derived challenge verifies', () => {
    expect(verify(makeAssertion())).toEqual({ ok: true, credentialId: CREDENTIAL.credentialId });
  });

  it('refuses when NO credential is pinned (B5: never weaker than before)', () => {
    expect(verify(makeAssertion(), { ...PINNED, credentials: [] })).toEqual({ ok: false, reason: 'no_pinned_credential' });
  });

  it('refuses when the pinned rpId or origin is blank', () => {
    expect(verify(makeAssertion(), { ...PINNED, rpId: '' })).toEqual({ ok: false, reason: 'no_pinned_credential' });
    expect(verify(makeAssertion(), { ...PINNED, origin: '' })).toEqual({ ok: false, reason: 'no_pinned_credential' });
  });

  it.each([
    ['not an object', 42],
    ['missing signature', { credentialId: 'a', authenticatorData: 'a', clientDataJSON: 'a' }],
    ['an extra field', { ...makeAssertion(), isAdmin: true }],
    ['non-base64url authenticatorData', { ...makeAssertion(), authenticatorData: 'not base64!!' }],
    ['non-base64url signature', { ...makeAssertion(), signature: '***' }],
  ])('refuses a malformed assertion (%s) rather than throwing', (_label, assertion) => {
    expect(verify(assertion)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses a truncated authenticatorData (under 37 bytes)', () => {
    expect(verify({ ...makeAssertion(), authenticatorData: b64url(Buffer.alloc(10)) })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses clientDataJSON that is not a JSON object with string fields', () => {
    expect(verify({ ...makeAssertion(), clientDataJSON: b64url(Buffer.from('not json')) })).toEqual({ ok: false, reason: 'malformed' });
    expect(verify({ ...makeAssertion(), clientDataJSON: b64url(Buffer.from(JSON.stringify({ type: 1, challenge: 2, origin: 3 }))) })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses a registration ceremony replayed as an approval (type !== webauthn.get)', () => {
    expect(verify(makeAssertion({ type: 'webauthn.create' }))).toEqual({ ok: false, reason: 'wrong_type' });
  });

  it('THE PROPERTY: an assertion bound to a DIFFERENT frozen request is refused', () => {
    const other: OwnerApprovalRequest = { ...REQUEST, cmd: 'curl', args: ['evil.example'] };
    const assertion = makeAssertion({ challenge: deriveOwnerApprovalChallenge({ envId: ENV_ID, challengeId: CHALLENGE_ID, request: other }, sha256) });
    expect(verify(assertion)).toEqual({ ok: false, reason: 'challenge_mismatch' });
  });

  it('an assertion bound to a different challenge id is refused', () => {
    const assertion = makeAssertion({ challenge: deriveOwnerApprovalChallenge({ envId: ENV_ID, challengeId: 'chal_other', request: REQUEST }, sha256) });
    expect(verify(assertion)).toEqual({ ok: false, reason: 'challenge_mismatch' });
  });

  it('an assertion bound to another environment is refused', () => {
    const assertion = makeAssertion({ challenge: deriveOwnerApprovalChallenge({ envId: 'env_other', challengeId: CHALLENGE_ID, request: REQUEST }, sha256) });
    expect(verify(assertion)).toEqual({ ok: false, reason: 'challenge_mismatch' });
  });

  it('refuses an origin that is not the one pinned at enrolment', () => {
    expect(verify(makeAssertion({ origin: 'https://evil.example' }))).toEqual({ ok: false, reason: 'origin_mismatch' });
  });

  it('refuses an rpIdHash that is not the rpId pinned at enrolment', () => {
    expect(verify(makeAssertion({ rpId: 'evil.example' }))).toEqual({ ok: false, reason: 'rp_mismatch' });
  });

  it('refuses when the user-present flag is unset (a silent authenticator is not a click)', () => {
    expect(verify(makeAssertion({ flags: 0x04 }))).toEqual({ ok: false, reason: 'user_not_present' });
  });

  it('refuses a credential id outside the pinned set', () => {
    expect(verify(makeAssertion({ credentialId: b64url(Buffer.from('some-other-key')) }))).toEqual({ ok: false, reason: 'unknown_credential' });
  });

  it('refuses a signature made by a key that is not the pinned one', () => {
    const impostor = makeCredential();
    expect(verify(makeAssertion({ signWith: impostor.sign }))).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses when the PINNED COSE key is unusable, rather than throwing', () => {
    const broken: PinnedOwnerApproval = { ...PINNED, credentials: [{ credentialId: CREDENTIAL.credentialId, publicKeyCose: b64url(Buffer.from([0xa1, 0x01, 0x02])) }] };
    expect(verify(makeAssertion(), broken)).toEqual({ ok: false, reason: 'bad_credential' });
  });

  it('never throws on hostile bytes, whatever they are', () => {
    const hostile = [null, [], '', { credentialId: ' ', authenticatorData: 'AA', clientDataJSON: 'AA', signature: 'AA' }, { credentialId: 'A'.repeat(5000), authenticatorData: 'A', clientDataJSON: 'A', signature: 'A' }];
    for (const assertion of hostile) expect(() => verify(assertion)).not.toThrow();
  });

  it('a primitive that throws is a refusal, not a crash', () => {
    const explode = () => {
      throw new Error('boom');
    };
    expect(verifyOwnerApproval({ assertion: makeAssertion(), pinned: PINNED, envId: ENV_ID, challengeId: CHALLENGE_ID, request: REQUEST, sha256, verifyEs256: explode })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyOwnerApproval({ assertion: makeAssertion(), pinned: PINNED, envId: ENV_ID, challengeId: CHALLENGE_ID, request: REQUEST, sha256: explode as unknown as Sha256Bytes, verifyEs256: es256Verify })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('the deny order is fixed: the earlier check wins when two are wrong at once', () => {
    // Wrong type AND wrong origin AND user-not-present ⇒ wrong_type (the first).
    expect(verify(makeAssertion({ type: 'webauthn.create', origin: 'https://evil.example', flags: 0x00 }))).toEqual({ ok: false, reason: 'wrong_type' });
    // Wrong challenge AND wrong origin ⇒ challenge_mismatch.
    expect(verify(makeAssertion({ challenge: 'AAAA', origin: 'https://evil.example' }))).toEqual({ ok: false, reason: 'challenge_mismatch' });
    // Wrong origin AND wrong rpId ⇒ origin_mismatch.
    expect(verify(makeAssertion({ origin: 'https://evil.example', rpId: 'evil.example' }))).toEqual({ ok: false, reason: 'origin_mismatch' });
    // Wrong rpId AND no user present ⇒ rp_mismatch.
    expect(verify(makeAssertion({ rpId: 'evil.example', flags: 0x00 }))).toEqual({ ok: false, reason: 'rp_mismatch' });
    // No user present AND unknown credential ⇒ user_not_present.
    expect(verify(makeAssertion({ flags: 0x00, credentialId: b64url(Buffer.from('nope')) }))).toEqual({ ok: false, reason: 'user_not_present' });
    // Unknown credential AND bad signature ⇒ unknown_credential.
    const impostor = makeCredential();
    expect(verify(makeAssertion({ credentialId: b64url(Buffer.from('nope')), signWith: impostor.sign }))).toEqual({ ok: false, reason: 'unknown_credential' });
    expect(OWNER_APPROVAL_DENY_ORDER).toEqual(['no_pinned_credential', 'malformed', 'wrong_type', 'challenge_mismatch', 'origin_mismatch', 'rp_mismatch', 'user_not_present', 'unknown_credential', 'bad_credential', 'bad_signature']);
  });
});

describe('COSE EC2 → JWK (the primitive nothing in the CLI had)', () => {
  it('parses a real ES256 credential public key', () => {
    const jwk = coseEc2ToJwk(Buffer.from(CREDENTIAL.publicKeyCose, 'base64url'));
    expect(jwk).not.toBeNull();
    expect(jwk!.kty).toBe('EC');
    expect(jwk!.crv).toBe('P-256');
    expect(Buffer.from(jwk!.x, 'base64url')).toHaveLength(32);
    expect(Buffer.from(jwk!.y, 'base64url')).toHaveLength(32);
  });

  it.each<[string, number[]]>([
    ['empty', []],
    ['not a map', [0x01]],
    ['an indefinite-length map', [0xbf, 0x01, 0x02, 0xff]],
    ['a truncated byte string', [0xa1, 0x21, 0x58, 0x20, 0x00]],
    ['trailing bytes after the map', [0xa1, 0x01, 0x02, 0x00]],
    ['a text-string key', [0xa1, 0x61, 0x61, 0x02]],
  ])('refuses hostile COSE bytes (%s) with null, never a throw', (_label, bytes) => {
    expect(coseEc2ToJwk(new Uint8Array(bytes))).toBeNull();
  });

  it('refuses a key that is not EC2/ES256/P-256', () => {
    const swap = (cose: Buffer, index: number, value: number) => {
      const copy = Buffer.from(cose);
      copy[index] = value;
      return copy;
    };
    const cose = Buffer.from(CREDENTIAL.publicKeyCose, 'base64url');
    // kty 2 → 1 (OKP)
    expect(coseEc2ToJwk(swap(cose, 2, 0x01))).toBeNull();
    // alg -7 (0x26) → -8 (0x27)
    expect(coseEc2ToJwk(swap(cose, 4, 0x27))).toBeNull();
    // crv 1 → 2 (P-384)
    expect(coseEc2ToJwk(swap(cose, 6, 0x02))).toBeNull();
  });

  /**
   * Each row below is shaped so that ONE guard, and only one, refuses it: the
   * bytes are otherwise a complete, well-formed EC2 ES256 P-256 key that ends
   * exactly on the buffer. Without that guard the parser would hand back a
   * usable JWK, which is what makes these mutation-checkable rather than
   * merely redundant with the checks around them.
   */
  describe('each structural guard is independently load-bearing', () => {
    /** The five COSE entries of the real credential, without the map header. */
    const body = Buffer.from(CREDENTIAL.publicKeyCose, 'base64url').subarray(1);
    const x = body.subarray(9, 41);

    it('a CBOR ARRAY carrying the same five entries is refused (only the major-type guard sees it)', () => {
      // 0x85 = array(5): ten values follow, exactly as five label/value pairs would.
      expect(coseEc2ToJwk(Buffer.concat([Buffer.from([0x85]), body]))).toBeNull();
    });

    it('a trailing byte after a complete key is refused (only the trailing guard sees it)', () => {
      expect(coseEc2ToJwk(Buffer.concat([Buffer.from([0xa5]), body, Buffer.from([0x00])]))).toBeNull();
    });

    it('a byte-string LABEL beside the five real entries is refused (only the label-type guard sees it)', () => {
      // map(6): one bstr-labelled entry the switch would ignore, then the real five.
      expect(coseEc2ToJwk(Buffer.concat([Buffer.from([0xa6, 0x41, 0x09, 0x01]), body]))).toBeNull();
    });

    it('a 31-byte x coordinate is refused (only the coordinate-length guard sees it)', () => {
      const short = Buffer.concat([
        Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x1f]),
        x.subarray(0, 31),
        body.subarray(41),
      ]);
      expect(coseEc2ToJwk(short)).toBeNull();
    });
  });
});
