import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify, createPublicKey, createHash } from 'node:crypto';
import {
  encodeGrant,
  canonicalizeArgs,
  verifyGrant,
  createMemoryNonceStore,
  GRANT_MAX_TTL_MS,
  GRANT_MAX_CLOCK_SKEW_MS,
  type Grant,
  type Ed25519Verify,
  type HashBytes,
  type NonceStore,
  type GrantRequest,
} from '../grant';
import type { ExecGrantArgs } from '../grant-args';

// ---------------------------------------------------------------------------
// Fixtures. Real Ed25519 keys and a real SHA-256 so the signature and hashing
// paths are exercised for real, but both primitives are still INJECTED into
// verifyGrant — the module under test never touches node:crypto (it must stay
// pure).
// ---------------------------------------------------------------------------

const server = generateKeyPairSync('ed25519');
const rogue = generateKeyPairSync('ed25519');

const serverPublicKey = new Uint8Array(server.publicKey.export({ type: 'spki', format: 'der' }));

const verify: Ed25519Verify = (message, signature, publicKey) =>
  nodeVerify(null, message, createPublicKey({ key: Buffer.from(publicKey), type: 'spki', format: 'der' }), signature);

const hash: HashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');

function signWith(privateKey: typeof server.privateKey, grant: Grant): string {
  return Buffer.from(nodeSign(null, encodeGrant(grant), privateKey)).toString('base64');
}

const NOW = 1_800_000_000_000; // fixed clock — verifyGrant must never read Date.now()
const ENV = 'env_local_1';

/** The request the grant in makeGrant() was issued for. */
/** The exec PROJECTION (`grantArgsForFrame`): the fixed field set, absent limits as null. */
const ARGS: ExecGrantArgs = { cmd: 'ls', args: ['-la'], cwd: '/home/u/proj', env: { LANG: 'C' }, timeoutMs: null, maxBytes: null };
const ARGS_HASH = hash(canonicalizeArgs(ARGS));

function makeGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    grantId: 'grant_1',
    envId: ENV,
    principal: { userId: 'user_1', sessionId: 'session_1', conversationId: 'conv_1' },
    op: 'exec',
    argsHash: ARGS_HASH,
    iat: NOW - 1_000,
    exp: NOW + 30_000,
    nonce: 'nonce_1',
    ...overrides,
  };
}

interface RunOpts {
  signature?: string;
  nonces?: NonceStore;
  expectedEnvId?: string;
  now?: number;
  key?: Uint8Array;
  request?: GrantRequest;
}

function run(grant: unknown, opts: RunOpts = {}) {
  const signature = opts.signature ?? signWith(server.privateKey, grant as Grant);
  return verifyGrant({
    grant,
    signature,
    serverPublicKey: opts.key ?? serverPublicKey,
    now: opts.now ?? NOW,
    nonces: opts.nonces ?? createMemoryNonceStore(),
    expectedEnvId: opts.expectedEnvId ?? ENV,
    request: opts.request ?? { op: 'exec', args: ARGS },
    verify,
    hash,
  });
}

describe('verifyGrant — the daemon-side authorization gate (invariant 3)', () => {
  it('given a well-formed grant signed by the pinned server key, bound to this exact request, with an unseen nonce, should return ok with the parsed grant AND record the nonce', () => {
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
    ['exp', NOW + 20_000],
    ['grantId', 'grant_2'],
    ['nonce', 'nonce_2'],
  ])('given field %s altered AFTER signing, should deny bad_signature (canonical encoding is field-stable)', (field, value) => {
    // envId / op / argsHash are deliberately absent from this table: tampering
    // them fails EARLIER as wrong_env / op_mismatch / args_mismatch, each pinned
    // by its own test below.
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

  // -------------------------------------------------------------------------
  // Request binding (Codex P1 on PR #2527). A captured, unused, correctly signed
  // grant must be useless for any work other than the exact request it was
  // issued for. The gate itself compares the signed op/argsHash against the
  // frame that carries the grant — it is not left to a later layer.
  // -------------------------------------------------------------------------

  it('given a valid signed grant carried by a frame whose op differs from the signed op, should deny op_mismatch and not burn the nonce', () => {
    const nonces = createMemoryNonceStore();
    const grant = makeGrant({ op: 'fs_read' });
    expect(run(grant, { nonces, request: { op: 'exec', args: ARGS } })).toEqual({ ok: false, reason: 'op_mismatch' });
    expect(nonces.has(grant.nonce)).toBe(false);
  });

  it('given a valid signed grant carried by a frame whose args hash to something other than the signed argsHash, should deny args_mismatch and not burn the nonce (request substitution)', () => {
    const nonces = createMemoryNonceStore();
    const grant = makeGrant();
    const substituted = { ...ARGS, cmd: 'rm', args: ['-rf', '/'] };
    expect(run(grant, { nonces, request: { op: 'exec', args: substituted } })).toEqual({ ok: false, reason: 'args_mismatch' });
    expect(nonces.has(grant.nonce)).toBe(false);
  });

  it('given an attacker who rewrites grant.argsHash to match their own args and sends those args, should deny bad_signature (the signature covers argsHash)', () => {
    const original = makeGrant();
    const signature = signWith(server.privateKey, original);
    const evilArgs = { ...ARGS, cmd: 'curl', args: ['evil'] };
    const retargeted = { ...original, argsHash: hash(canonicalizeArgs(evilArgs)) };
    expect(run(retargeted, { signature, request: { op: 'exec', args: evilArgs } })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('given the same args with object keys in a different order, should still bind (canonical hashing)', () => {
    const reordered: ExecGrantArgs = { maxBytes: null, timeoutMs: null, env: { LANG: 'C' }, cwd: '/home/u/proj', args: ['-la'], cmd: 'ls' };
    expect(run(makeGrant(), { request: { op: 'exec', args: reordered } }).ok).toBe(true);
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

  // C15 (Codex adversarial review): a grant whose window is negative is not a
  // "short TTL", it is not a grant. Structural, so it is `malformed` and is
  // judged BEFORE ttl_too_long — and before anything that costs more.
  it('given exp < iat, should deny malformed — evaluated before ttl_too_long (C15)', () => {
    expect(run(makeGrant({ iat: NOW, exp: NOW - 1 }))).toEqual({ ok: false, reason: 'malformed' });
  });

  it('given exp < iat AND a wrong envId, should still deny malformed — the structural check beats wrong_env in the fixed order', () => {
    expect(run(makeGrant({ envId: 'env_other', iat: NOW, exp: NOW - 1 }))).toEqual({ ok: false, reason: 'malformed' });
  });

  it('given exp === iat (a zero-length window), should NOT be malformed — it is simply expired the instant after', () => {
    expect(run(makeGrant({ iat: NOW, exp: NOW }))).toEqual({ ok: true, grant: makeGrant({ iat: NOW, exp: NOW }) });
    expect(run(makeGrant({ iat: NOW - 1, exp: NOW - 1 }))).toEqual({ ok: false, reason: 'expired' });
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
    run(makeGrant({ nonce: 'n_op' }), { nonces, request: { op: 'fs_write', args: { files: [] } } });
    run(makeGrant({ nonce: 'n_args' }), { nonces, request: { op: 'exec', args: { ...ARGS, cmd: 'other' } } });
    expect(nonces.has(grant.nonce)).toBe(false);
    for (const n of ['n_env', 'n_exp', 'n_op', 'n_args']) expect(nonces.has(n)).toBe(false);
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
    const input = { grant, signature, serverPublicKey, now: NOW, expectedEnvId: ENV, request: { op: 'exec' as const, args: ARGS }, verify, hash };
    const a = verifyGrant({ ...input, nonces: createMemoryNonceStore() });
    const b = verifyGrant({ ...input, nonces: createMemoryNonceStore() });
    expect(a).toEqual(b);
  });

  it('should enforce a fixed deny order: wrong_env is reported before signature is even checked', () => {
    // A grant for another env signed by a ROGUE key: wrong_env must win (cheap
    // structural checks run before crypto), proving the order is fixed rather
    // than incidental.
    const grant = makeGrant({ envId: 'env_other' });
    expect(run(grant, { signature: signWith(rogue.privateKey, grant) })).toEqual({ ok: false, reason: 'wrong_env' });
  });

  it('should enforce a fixed deny order: request binding is checked before the signature', () => {
    const grant = makeGrant();
    const verdict = run(grant, { signature: signWith(rogue.privateKey, grant), request: { op: 'pty_open', args: { cols: 80, rows: 24, cwd: null, command: null, args: [] } } });
    expect(verdict).toEqual({ ok: false, reason: 'op_mismatch' });
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

describe('canonicalizeArgs — the bytes both ends hash to bind a grant to its request', () => {
  const bytes = (v: unknown) => Buffer.from(canonicalizeArgs(v)).toString('utf8');

  it('given objects with keys in different orders (including nested), should produce identical bytes', () => {
    expect(bytes({ a: 1, b: { c: 2, d: [3, { e: 4, f: 5 }] } })).toBe(bytes({ b: { d: [3, { f: 5, e: 4 }], c: 2 }, a: 1 }));
  });

  it('should preserve array order (arguments are positional)', () => {
    expect(bytes({ args: ['-la', '/'] })).not.toBe(bytes({ args: ['/', '-la'] }));
  });

  it('should distinguish values that JSON would otherwise conflate', () => {
    expect(bytes({ a: 1 })).not.toBe(bytes({ a: '1' }));
    expect(bytes({ a: null })).not.toBe(bytes({}));
  });

  it('should drop undefined-valued keys the same way at both ends (they are not on the wire)', () => {
    expect(bytes({ a: 1, b: undefined })).toBe(bytes({ a: 1 }));
  });

  it('should be deterministic for primitives and nested arrays', () => {
    expect(bytes([1, 'x', [true, null]])).toBe(bytes([1, 'x', [true, null]]));
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

describe('GA wave 2 — approvalIntent: the owner\'s click rides the re-issued grant, signed under the pinned key', () => {
  const INTENT = { challengeId: 'ch_1', scope: '30d' as const, expiresAt: NOW + 30_000 };
  const request = { op: 'exec' as const, args: ARGS };
  const nonces = () => createMemoryNonceStore();

  it('given a grant carrying a well-formed approvalIntent signed by the server, should verify and hand the intent back on the Grant', () => {
    const grant = makeGrant({ approvalIntent: INTENT });
    const verdict = verifyGrant({ grant, signature: signWith(server.privateKey, grant), serverPublicKey, now: NOW, nonces: nonces(), expectedEnvId: ENV, request, verify, hash });
    expect(verdict).toEqual({ ok: true, grant });
  });

  it('a grant WITHOUT an intent keeps the bytes it always had (no approvalIntent key is ever added)', () => {
    expect(Buffer.from(encodeGrant(makeGrant())).toString()).not.toContain('approvalIntent');
    expect(Buffer.from(encodeGrant(makeGrant({ approvalIntent: INTENT }))).toString()).toContain('"approvalIntent":{"challengeId":"ch_1","scope":"30d","expiresAt":');
  });

  it.each([
    ['added after signing', makeGrant(), makeGrant({ approvalIntent: INTENT })],
    ['removed after signing', makeGrant({ approvalIntent: INTENT }), makeGrant()],
    ['challengeId altered', makeGrant({ approvalIntent: INTENT }), makeGrant({ approvalIntent: { ...INTENT, challengeId: 'ch_other' } })],
    ['scope widened', makeGrant({ approvalIntent: INTENT }), makeGrant({ approvalIntent: { ...INTENT, scope: 'until_revoked' } })],
    ['expiry extended', makeGrant({ approvalIntent: INTENT }), makeGrant({ approvalIntent: { ...INTENT, expiresAt: INTENT.expiresAt + 1 } })],
  ])('given the intent %s, should deny bad_signature — a click cannot be forged or edited in flight', (_label, signed, presented) => {
    const verdict = verifyGrant({ grant: presented, signature: signWith(server.privateKey, signed), serverPublicKey, now: NOW, nonces: nonces(), expectedEnvId: ENV, request, verify, hash });
    expect(verdict).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it.each([
    ['an unknown scope', { ...INTENT, scope: 'forever' }],
    ['an extra field', { ...INTENT, isAdmin: true }],
    ['an empty challengeId', { ...INTENT, challengeId: '' }],
    ['a missing expiry', { challengeId: 'ch_1', scope: '30d' }],
  ])('given an intent with %s, should deny malformed', (_label, approvalIntent) => {
    const grant = { ...makeGrant(), approvalIntent } as unknown as Grant;
    const verdict = verifyGrant({ grant, signature: signWith(server.privateKey, grant), serverPublicKey, now: NOW, nonces: nonces(), expectedEnvId: ENV, request, verify, hash });
    expect(verdict).toEqual({ ok: false, reason: 'malformed' });
  });
});

/**
 * B3 — the assertion the owner's click carries rides INSIDE `approvalIntent`,
 * which is already inside `encodeGrant`'s canonical bytes, so the server's
 * signature covers it and it cannot be swapped or stripped in flight.
 */
describe('hardening B — the approval intent carries the assertion', () => {
  const ASSERTION = { credentialId: 'cred-a', authenticatorData: 'YXV0aA', clientDataJSON: 'Y2xpZW50', signature: 'c2ln' };
  const intentOf = (extra: Record<string, unknown> = {}) => ({ challengeId: 'chal_1', scope: 'once' as const, expiresAt: 1_000, ...extra }) as NonNullable<Grant['approvalIntent']>;

  it('NO REGRESSION: a grant with no approvalIntent encodes to exactly the bytes it always had', () => {
    const grant = makeGrant();
    const encoded = new TextDecoder().decode(encodeGrant(grant));
    expect(encoded).not.toContain('approvalIntent');
    expect(JSON.parse(encoded)).toEqual({
      grantId: grant.grantId,
      envId: grant.envId,
      principal: grant.principal,
      op: grant.op,
      argsHash: grant.argsHash,
      iat: grant.iat,
      exp: grant.exp,
      nonce: grant.nonce,
    });
  });

  it('an intent WITHOUT an assertion encodes exactly as it did before the field existed', () => {
    const encoded = new TextDecoder().decode(encodeGrant({ ...makeGrant(), approvalIntent: intentOf() }));
    expect(JSON.parse(encoded).approvalIntent).toEqual({ challengeId: 'chal_1', scope: 'once', expiresAt: 1_000 });
    expect(encoded).not.toContain('assertion');
  });

  it('an intent WITH an assertion puts all four fields under the signature, in a fixed order', () => {
    const encoded = new TextDecoder().decode(encodeGrant({ ...makeGrant(), approvalIntent: intentOf({ assertion: ASSERTION }) }));
    expect(JSON.parse(encoded).approvalIntent.assertion).toEqual(ASSERTION);
    // Rebuilt field by field, so the caller's insertion order cannot change the signed message.
    const shuffled = { signature: 'c2ln', clientDataJSON: 'Y2xpZW50', authenticatorData: 'YXV0aA', credentialId: 'cred-a' };
    expect(encodeGrant({ ...makeGrant(), approvalIntent: intentOf({ assertion: shuffled }) })).toEqual(encodeGrant({ ...makeGrant(), approvalIntent: intentOf({ assertion: ASSERTION }) }));
  });

  it('changing ONE byte of the assertion changes the signed bytes — it cannot be swapped in flight', () => {
    const withAssertion = encodeGrant({ ...makeGrant(), approvalIntent: intentOf({ assertion: ASSERTION }) });
    const tampered = encodeGrant({ ...makeGrant(), approvalIntent: intentOf({ assertion: { ...ASSERTION, signature: 'c2lo' } }) });
    expect(withAssertion).not.toEqual(tampered);
    // …and stripping it is a different message too, so a captured click cannot be downgraded to an unproven one.
    expect(withAssertion).not.toEqual(encodeGrant({ ...makeGrant(), approvalIntent: intentOf() }));
  });

  it.each<[string, unknown]>([
    ['a non-object assertion', 'nope'],
    ['a missing signature', { credentialId: 'a', authenticatorData: 'b', clientDataJSON: 'c' }],
    ['an empty credential id', { ...ASSERTION, credentialId: '' }],
    ['an extra field riding along', { ...ASSERTION, isAdmin: true }],
  ])('verifyGrant refuses a grant whose assertion is %s as MALFORMED — the schema is strict', (_label, assertion) => {
    const grant = { ...makeGrant(), approvalIntent: intentOf({ assertion }) };
    expect(run(grant)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('verifies a grant whose intent carries a well-formed assertion, and hands the assertion back untouched', () => {
    const grant = { ...makeGrant(), approvalIntent: intentOf({ assertion: ASSERTION }) };
    const verdict = run(grant);
    expect(verdict.ok && verdict.grant.approvalIntent?.assertion).toEqual(ASSERTION);
  });
});
