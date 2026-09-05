import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify, createHash } from 'node:crypto';
import { parseServerSigningKey, ENV_BRIDGE_SIGNING_KEY_VAR, type SigningKeyPrimitives } from '../server-signing-key';

// Real Ed25519 primitives, INJECTED — the pure parser never imports node:crypto.
const primitives: SigningKeyPrimitives = {
  importPrivateKey: (pkcs8) => {
    try {
      const privateKey = createPrivateKey({ key: Buffer.from(pkcs8), type: 'pkcs8', format: 'der' });
      if (privateKey.asymmetricKeyType !== 'ed25519') return null;
      const publicKey = new Uint8Array(createPublicKey(privateKey).export({ type: 'spki', format: 'der' }));
      return { publicKey, sign: (message) => new Uint8Array(nodeSign(null, message, privateKey)) };
    } catch {
      return null;
    }
  },
  hash: (bytes) => createHash('sha256').update(bytes).digest('hex'),
};

const pair = generateKeyPairSync('ed25519');
const rawPkcs8 = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const spki = new Uint8Array(pair.publicKey.export({ type: 'spki', format: 'der' }));

describe('parseServerSigningKey — the key whose signature every grant carries (invariant 3)', () => {
  it('given a base64 PKCS#8 Ed25519 key, should yield the public key (SPKI), a stable keyId derived from it, and a sign() that the public key verifies', () => {
    const verdict = parseServerSigningKey(rawPkcs8, primitives);
    if (!verdict.ok) throw new Error(verdict.reason);
    expect(Buffer.from(verdict.key.publicKey).equals(Buffer.from(spki))).toBe(true);
    expect(verdict.key.keyId).toBe(primitives.hash(spki).slice(0, 16));
    const message = new TextEncoder().encode('grant');
    expect(nodeVerify(null, message, pair.publicKey, verdict.key.sign(message))).toBe(true);
  });

  it('given the variable unset or blank, should return unset — the caller must fail closed, never mint an ephemeral key', () => {
    expect(parseServerSigningKey(undefined, primitives)).toEqual({ ok: false, reason: 'unset' });
    expect(parseServerSigningKey('   ', primitives)).toEqual({ ok: false, reason: 'unset' });
  });

  it('given something that is not base64, not PKCS#8, or not Ed25519, should return malformed', () => {
    expect(parseServerSigningKey('not base64!!', primitives)).toEqual({ ok: false, reason: 'malformed' });
    expect(parseServerSigningKey(Buffer.from('garbage').toString('base64'), primitives)).toEqual({ ok: false, reason: 'malformed' });
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
    expect(parseServerSigningKey(rsa, primitives)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('should name the environment variable operators must set', () => {
    expect(ENV_BRIDGE_SIGNING_KEY_VAR).toBe('ENV_BRIDGE_SIGNING_KEY');
  });

  it('should tolerate surrounding whitespace in the raw value (the way secrets get pasted)', () => {
    expect(parseServerSigningKey(`  ${rawPkcs8}\n`, primitives).ok).toBe(true);
  });
});
