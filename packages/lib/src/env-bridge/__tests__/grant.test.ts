import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify, createPublicKey } from 'node:crypto';
import {
  encodeGrant,
  verifyGrant,
  createMemoryNonceStore,
  GRANT_MAX_TTL_MS,
  GRANT_MAX_CLOCK_SKEW_MS,
  type Grant,
  type Ed25519Verify,
  type NonceStore,
} from '../grant';

// ---------------------------------------------------------------------------
// Fixtures. Real Ed25519 keys so the signature path is exercised for real, but
// the verifier is still INJECTED into verifyGrant — the module under test never
// touches node:crypto itself (it must stay pure).
// ---------------------------------------------------------------------------

const server = generateKeyPairSync('ed25519');
const rogue = generateKeyPairSync('ed25519');

const serverPublicKey = new Uint8Array(server.publicKey.export({ type: 'spki', format: 'der' }));

const verify: Ed25519Verify = (message, signature, publicKey) =>
  nodeVerify(null, message, createPublicKey({ key: Buffer.from(publicKey), type: 'spki', format: 'der' }), signature);

function signWith(privateKey: typeof server.privateKey, grant: Grant): string {
  return Buffer.from(nodeSign(null, encodeGrant(grant), privateKey)).toString('base64');
}

const NOW = 1_800_000_000_000; // fixed clock — verifyGrant must never read Date.now()
const ENV = 'env_local_1';

function makeGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    grantId: 'grant_1',
    envId: ENV,
    principal: { userId: 'user_1', sessionId: 'session_1', conversationId: 'conv_1' },
    op: 'exec',
    argsHash: 'a'.repeat(64),
    iat: NOW - 1_000,
    exp: NOW + 30_000,
    nonce: 'nonce_1',
    ...overrides,
  };
}

function run(grant: unknown, opts: { signature?: string; nonces?: NonceStore; expectedEnvId?: string; now?: number; key?: Uint8Array } = {}) {
  const signature = opts.signature ?? signWith(server.privateKey, grant as Grant);
  return verifyGrant({
    grant,
    signature,
    serverPublicKey: opts.key ?? serverPublicKey,
    now: opts.now ?? NOW,
    nonces: opts.nonces ?? createMemoryNonceStore(),
    expectedEnvId: opts.expectedEnvId ?? ENV,
    verify,
  });
}

describe('verifyGrant — the daemon-side authorization gate (invariant 3)', () => {
  it('given a well-formed grant signed by the pinned server key with an unseen nonce, should return ok with the parsed grant AND record the nonce', () => {
    const nonces = createMemoryNonceStore();
    const grant = makeGrant();
    const verdict = run(grant, { nonces });
    expect(verdict).toEqual({ ok: true, grant });
    expect(nonces.has(grant.nonce)).toBe(true);
  });

  it('given a grant signed by a different key, should deny bad_signature', () => {
    const grant = makeGrant();
    const verdict = run(grant, { signature: signWith(rogue.privateKey, grant) });
    expect(verdict).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it.each<[keyof Grant, Grant[keyof Grant]]>([
    ['op', 'fs_write'],
    ['argsHash', 'b'.repeat(64)],
    ['exp', NOW + 20_000],
    ['grantId', 'grant_2'],
    ['nonce', 'nonce_2'],
  ])('given field %s altered AFTER signing, should deny bad_signature (canonical encoding is field-stable)', (field, value) => {
    // envId is deliberately absent from this table: tampering it fails EARLIER as
    // wrong_env, which the deny-order test below pins.
    const original = makeGrant();
    const signature = signWith(server.privateKey, original);
    const tampered = { ...original, [field]: value };
    expect(run(tampered, { signature })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('given the principal altered after signing, should deny bad_signature', () => {
    const original = makeGrant();
    const signature = signWith(server.privateKey, original);
    const tampered = { ...original, principal: { ...original.principal, userId: 'user_evil' } };
    expect(run(tampered, { signature })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('given exp < now, should deny expired', () => {
    expect(run(makeGrant({ iat: NOW - 50_000, exp: NOW - 1 }))).toEqual({ ok: false, reason: 'expired' });
  });

  it('given iat more than the allowed skew in the future, should deny clock_skew', () => {
    const iat = NOW + GRANT_MAX_CLOCK_SKEW_MS + 1;
    expect(run(makeGrant({ iat, exp: iat + 10_000 }))).toEqual({ ok: false, reason: 'clock_skew' });
  });

  it('given iat within the allowed skew in the future, should NOT deny for skew', () => {
    const iat = NOW + GRANT_MAX_CLOCK_SKEW_MS;
    expect(run(makeGrant({ iat, exp: iat + 10_000 })).ok).toBe(true);
  });

  it('given exp - iat > the max TTL, should deny ttl_too_long even when otherwise valid and unexpired', () => {
    expect(run(makeGrant({ iat: NOW - 1_000, exp: NOW - 1_000 + GRANT_MAX_TTL_MS + 1 }))).toEqual({ ok: false, reason: 'ttl_too_long' });
  });

  it('given exp - iat exactly the max TTL, should allow', () => {
    expect(run(makeGrant({ iat: NOW - 1_000, exp: NOW - 1_000 + GRANT_MAX_TTL_MS })).ok).toBe(true);
  });

  it('given grant.envId !== expectedEnvId, should deny wrong_env (a grant for another machine never runs here)', () => {
    expect(run(makeGrant({ envId: 'env_other' }))).toEqual({ ok: false, reason: 'wrong_env' });
  });

  it('given a nonce already present in the store, should deny replayed and NOT re-add it', () => {
    const nonces = createMemoryNonceStore();
    const grant = makeGrant();
    expect(run(grant, { nonces }).ok).toBe(true);
    let adds = 0;
    const spy: NonceStore = { has: (n) => nonces.has(n), add: (n, e) => { adds += 1; nonces.add(n, e); } };
    expect(run(grant, { nonces: spy })).toEqual({ ok: false, reason: 'replayed' });
    expect(adds).toBe(0);
  });

  it('given a grant that fails ANY check, should never record its nonce (a rejected grant cannot burn a nonce)', () => {
    const nonces = createMemoryNonceStore();
    const grant = makeGrant();
    run(grant, { nonces, signature: signWith(rogue.privateKey, grant) });
    run(makeGrant({ envId: 'env_other', nonce: 'n_env' }), { nonces });
    run(makeGrant({ iat: NOW - 50_000, exp: NOW - 1, nonce: 'n_exp' }), { nonces });
    expect(nonces.has(grant.nonce)).toBe(false);
    expect(nonces.has('n_env')).toBe(false);
    expect(nonces.has('n_exp')).toBe(false);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['a string', 'grant'],
    ['an array', []],
    ['a number', 42],
    ['missing nonce', (() => { const { nonce: _n, ...rest } = makeGrant(); return rest; })()],
    ['missing principal', (() => { const { principal: _p, ...rest } = makeGrant(); return rest; })()],
    ['mistyped iat', { ...makeGrant(), iat: '123' }],
    ['mistyped principal', { ...makeGrant(), principal: 'user_1' }],
    ['extra field', { ...makeGrant(), isAdmin: true }],
    ['op outside the closed union', { ...makeGrant(), op: 'rm_rf' }],
  ])('given %s, should deny malformed and never throw', (_label, input) => {
    expect(() => run(input, { signature: 'AAAA' })).not.toThrow();
    expect(run(input, { signature: 'AAAA' })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('given an undecodable signature string, should deny bad_signature and never throw', () => {
    expect(() => run(makeGrant(), { signature: '!!!not-base64!!!' })).not.toThrow();
    expect(run(makeGrant(), { signature: '' })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('should be deterministic: identical inputs yield identical verdicts (no hidden clock or randomness)', () => {
    const grant = makeGrant();
    const signature = signWith(server.privateKey, grant);
    const a = verifyGrant({ grant, signature, serverPublicKey, now: NOW, nonces: createMemoryNonceStore(), expectedEnvId: ENV, verify });
    const b = verifyGrant({ grant, signature, serverPublicKey, now: NOW, nonces: createMemoryNonceStore(), expectedEnvId: ENV, verify });
    expect(a).toEqual(b);
  });

  it('should enforce a fixed deny order: wrong_env is reported before signature is even checked', () => {
    // A grant for another env signed by a ROGUE key: wrong_env must win (cheap structural
    // checks run before crypto), proving the order is fixed rather than incidental.
    const grant = makeGrant({ envId: 'env_other' });
    expect(run(grant, { signature: signWith(rogue.privateKey, grant) })).toEqual({ ok: false, reason: 'wrong_env' });
  });
});

describe('encodeGrant — canonical bytes for signing', () => {
  it('given the same grant with keys in a different insertion order, should encode identical bytes', () => {
    const a = makeGrant();
    const b = { nonce: a.nonce, exp: a.exp, iat: a.iat, argsHash: a.argsHash, op: a.op, principal: { conversationId: a.principal.conversationId, sessionId: a.principal.sessionId, userId: a.principal.userId }, envId: a.envId, grantId: a.grantId } as Grant;
    expect(Buffer.from(encodeGrant(a)).equals(Buffer.from(encodeGrant(b)))).toBe(true);
  });

  it('given two grants differing in exactly one field, should encode different bytes', () => {
    expect(Buffer.from(encodeGrant(makeGrant())).equals(Buffer.from(encodeGrant(makeGrant({ nonce: 'x' }))))).toBe(false);
  });
});

describe('createMemoryNonceStore', () => {
  it('should report has() true only after add()', () => {
    const s = createMemoryNonceStore();
    expect(s.has('n')).toBe(false);
    s.add('n', NOW + 1);
    expect(s.has('n')).toBe(true);
  });
});
