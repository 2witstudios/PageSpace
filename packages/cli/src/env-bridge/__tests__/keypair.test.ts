import { describe, expect, it } from 'vitest';
import { createPublicKey, verify as nodeVerify } from 'node:crypto';
import { encodeChallenge, generateMachineKeypair, signWithMachineKey } from '../keypair.js';

describe('generateMachineKeypair / signWithMachineKey — the machine-held identity', () => {
  it('should produce an Ed25519 pair in the wire formats the server expects (base64 SPKI public, base64 PKCS#8 private), and a signature the public key verifies', () => {
    const pair = generateMachineKeypair();
    const publicKey = createPublicKey({ key: Buffer.from(pair.publicKey, 'base64'), type: 'spki', format: 'der' });
    expect(publicKey.asymmetricKeyType).toBe('ed25519');
    const message = new TextEncoder().encode('prove it');
    const signature = Buffer.from(signWithMachineKey(pair.privateKey, message), 'base64');
    expect(nodeVerify(null, message, publicKey, signature)).toBe(true);
    // A different message, or a different key, does not verify.
    expect(nodeVerify(null, new TextEncoder().encode('forged'), publicKey, signature)).toBe(false);
    const other = generateMachineKeypair();
    expect(nodeVerify(null, message, createPublicKey({ key: Buffer.from(other.publicKey, 'base64'), type: 'spki', format: 'der' }), signature)).toBe(false);
  });

  it('should generate a fresh pair every time', () => {
    expect(generateMachineKeypair().publicKey).not.toBe(generateMachineKeypair().publicKey);
  });
});

describe('encodeChallenge — byte-for-byte the server encoding', () => {
  it('should be the fixed-order, whitespace-free JSON the server signs against, regardless of the caller\'s key order', () => {
    const expected = '{"nonce":"n","enrollmentId":"e","exp":1}';
    expect(Buffer.from(encodeChallenge({ nonce: 'n', enrollmentId: 'e', exp: 1 })).toString()).toBe(expected);
    expect(Buffer.from(encodeChallenge({ exp: 1, enrollmentId: 'e', nonce: 'n' })).toString()).toBe(expected);
  });
});
