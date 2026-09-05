import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, verify as nodeVerify } from 'node:crypto';
import { loadServerSigningKey } from '../env-bridge-signing-key';

const pair = generateKeyPairSync('ed25519');
const raw = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');

describe('loadServerSigningKey — the node adapter over parseServerSigningKey', () => {
  it('given ENV_BRIDGE_SIGNING_KEY set to a base64 PKCS#8 Ed25519 key, should load a key whose signatures verify', () => {
    const key = loadServerSigningKey({ ENV_BRIDGE_SIGNING_KEY: raw });
    const message = new TextEncoder().encode('hello');
    expect(nodeVerify(null, message, pair.publicKey, key.sign(message))).toBe(true);
    expect(key.keyId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('given the variable unset, should THROW naming it — fail closed, never fall back to an ephemeral key', () => {
    expect(() => loadServerSigningKey({})).toThrow(/ENV_BRIDGE_SIGNING_KEY/);
    expect(() => loadServerSigningKey({})).toThrow(/required/i);
  });

  it('given a malformed value, should THROW naming the variable and the problem', () => {
    expect(() => loadServerSigningKey({ ENV_BRIDGE_SIGNING_KEY: 'nope' })).toThrow(/ENV_BRIDGE_SIGNING_KEY.*Ed25519/);
  });

  it('should be deterministic: the same variable loads the same keyId twice (no per-call randomness)', () => {
    expect(loadServerSigningKey({ ENV_BRIDGE_SIGNING_KEY: raw }).keyId).toBe(loadServerSigningKey({ ENV_BRIDGE_SIGNING_KEY: raw }).keyId);
  });
});
