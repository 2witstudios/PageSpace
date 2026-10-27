/**
 * Key rotation for the server signing key (Codex C10): `ENV_BRIDGE_SIGNING_KEYS`
 * lists current + previous keys so an enrollment pinned to a previous key is
 * still served — by THAT key — while `ENV_BRIDGE_SIGNING_KEY` keeps working as
 * the single-key form.
 */
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash, sign as nodeSign } from 'node:crypto';
import { parseServerSigningKeyring, parseServerSigningKey, type SigningKeyPrimitives } from '../server-signing-key';

const primitives: SigningKeyPrimitives = {
  importPrivateKey: (pkcs8) => {
    try {
      const privateKey = createPrivateKey({ key: Buffer.from(pkcs8), type: 'pkcs8', format: 'der' });
      if (privateKey.asymmetricKeyType !== 'ed25519') return null;
      return { publicKey: new Uint8Array(createPublicKey(privateKey).export({ type: 'spki', format: 'der' })), sign: (m) => new Uint8Array(nodeSign(null, m, privateKey)) };
    } catch {
      return null;
    }
  },
  hash: (bytes) => createHash('sha256').update(bytes).digest('hex'),
};

const pkcs8 = () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const k1 = pkcs8();
const k2 = pkcs8();
const k3 = pkcs8();
const idOf = (raw: string) => {
  const v = parseServerSigningKey(raw, primitives);
  if (!v.ok) throw new Error(v.reason);
  return v.key.keyId;
};

describe('parseServerSigningKeyring', () => {
  it('given only ENV_BRIDGE_SIGNING_KEY, should build a ring of one whose current is that key', () => {
    const v = parseServerSigningKeyring({ single: k1, multi: undefined }, primitives);
    if (!v.ok) throw new Error(v.reason);
    expect(v.keyring.current.keyId).toBe(idOf(k1));
    expect(v.keyring.keyIds).toEqual([idOf(k1)]);
    expect(v.keyring.get(idOf(k1))?.keyId).toBe(idOf(k1));
  });

  it('given ENV_BRIDGE_SIGNING_KEYS "current,previous", should make the FIRST current and still serve the previous by id', () => {
    const v = parseServerSigningKeyring({ single: undefined, multi: `${k1},${k2}` }, primitives);
    if (!v.ok) throw new Error(v.reason);
    expect(v.keyring.current.keyId).toBe(idOf(k1));
    expect(v.keyring.keyIds).toEqual([idOf(k1), idOf(k2)]);
    const previous = v.keyring.get(idOf(k2));
    expect(previous?.keyId).toBe(idOf(k2));
    // The previous key signs with ITS key, not the current one.
    const message = new TextEncoder().encode('m');
    expect(Buffer.from(previous!.sign(message)).equals(Buffer.from(v.keyring.current.sign(message)))).toBe(false);
  });

  it('given both variables, should honour ENV_BRIDGE_SIGNING_KEYS (the rotation form wins, documented)', () => {
    const v = parseServerSigningKeyring({ single: k3, multi: `${k1},${k2}` }, primitives);
    if (!v.ok) throw new Error(v.reason);
    expect(v.keyring.current.keyId).toBe(idOf(k1));
    expect(v.keyring.get(idOf(k3))).toBeNull();
  });

  it('given a key id not in the ring, should answer null — never a different key', () => {
    const v = parseServerSigningKeyring({ single: k1, multi: undefined }, primitives);
    if (!v.ok) throw new Error(v.reason);
    expect(v.keyring.get('nope')).toBeNull();
    expect(v.keyring.get(idOf(k2))).toBeNull();
  });

  it('given neither variable, should be unset', () => {
    expect(parseServerSigningKeyring({ single: undefined, multi: undefined }, primitives)).toEqual({ ok: false, reason: 'unset' });
    expect(parseServerSigningKeyring({ single: '  ', multi: '' }, primitives)).toEqual({ ok: false, reason: 'unset' });
  });

  it('given one malformed entry in the list, should refuse the whole ring naming the index — never load a partial ring', () => {
    expect(parseServerSigningKeyring({ single: undefined, multi: `${k1},not-a-key,${k2}` }, primitives)).toEqual({ ok: false, reason: 'malformed', index: 1 });
  });

  it('given the same key listed twice, should refuse as duplicate_key', () => {
    expect(parseServerSigningKeyring({ single: undefined, multi: `${k1},${k1}` }, primitives)).toEqual({ ok: false, reason: 'duplicate_key', index: 1 });
  });

  it('given whitespace and newlines around entries, should tolerate them', () => {
    const v = parseServerSigningKeyring({ single: undefined, multi: ` ${k1} ,\n${k2}\n` }, primitives);
    if (!v.ok) throw new Error(v.reason);
    expect(v.keyring.keyIds).toEqual([idOf(k1), idOf(k2)]);
  });
});
