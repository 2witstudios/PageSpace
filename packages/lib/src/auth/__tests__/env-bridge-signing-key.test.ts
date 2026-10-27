import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, verify as nodeVerify } from 'node:crypto';
import { loadServerSigningKey, loadServerSigningKeyring } from '../env-bridge-signing-key';

const pair = generateKeyPairSync('ed25519');
const raw = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const previousPair = generateKeyPairSync('ed25519');
const previousRaw = previousPair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');

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

describe('loadServerSigningKeyring — rotation (Codex C10)', () => {
  it('given ENV_BRIDGE_SIGNING_KEYS "current,previous", should make the first current and serve the previous BY ITS OWN key', () => {
    const ring = loadServerSigningKeyring({ ENV_BRIDGE_SIGNING_KEYS: `${raw},${previousRaw}` });
    expect(ring.current.keyId).toBe(loadServerSigningKey({ ENV_BRIDGE_SIGNING_KEY: raw }).keyId);
    const previousId = loadServerSigningKey({ ENV_BRIDGE_SIGNING_KEY: previousRaw }).keyId;
    const previous = ring.get(previousId);
    expect(previous).not.toBeNull();
    const message = new TextEncoder().encode('grant');
    expect(nodeVerify(null, message, previousPair.publicKey, previous!.sign(message))).toBe(true);
    expect(nodeVerify(null, message, pair.publicKey, previous!.sign(message))).toBe(false);
  });

  it('given ENV_BRIDGE_SIGNING_KEYS set, should let it win over ENV_BRIDGE_SIGNING_KEY and expose loadServerSigningKey as the ring\'s current', () => {
    expect(loadServerSigningKey({ ENV_BRIDGE_SIGNING_KEY: previousRaw, ENV_BRIDGE_SIGNING_KEYS: raw }).keyId).toBe(loadServerSigningKey({ ENV_BRIDGE_SIGNING_KEY: raw }).keyId);
  });

  it('given a key id that is no longer loaded, should answer null — the signer turns that into signing_key_unavailable, never another key', () => {
    const ring = loadServerSigningKeyring({ ENV_BRIDGE_SIGNING_KEYS: raw });
    expect(ring.get(loadServerSigningKey({ ENV_BRIDGE_SIGNING_KEY: previousRaw }).keyId)).toBeNull();
  });

  it('given one malformed entry in the list, should THROW naming the entry — never load a partial ring', () => {
    expect(() => loadServerSigningKeyring({ ENV_BRIDGE_SIGNING_KEYS: `${raw},nope` })).toThrow(/entry 1/);
    expect(() => loadServerSigningKeyring({ ENV_BRIDGE_SIGNING_KEYS: `${raw},${raw}` })).toThrow(/twice/);
  });
});
