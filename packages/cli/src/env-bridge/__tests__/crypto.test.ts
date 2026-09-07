import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { ed25519Verify, envBridgeHash } from '../crypto.js';
import { generateMachineKeypair, signWithMachineKey } from '../keypair.js';
import { decodeBase64 } from '@pagespace/lib/env-bridge/grant';

describe('env-bridge crypto primitives (must match apps/web/src/lib/env-bridge/crypto.ts byte for byte)', () => {
  it('envBridgeHash should be SHA-256, lowercase hex — the algorithm the server hashes argsHash and resultHash with', () => {
    const bytes = new TextEncoder().encode('{"a":1}');
    expect(envBridgeHash(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(envBridgeHash(bytes)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ed25519Verify should accept a signature made with signWithMachineKey and refuse a tampered message, never throwing on junk keys', () => {
    const pair = generateMachineKeypair();
    const message = new TextEncoder().encode('hello');
    const signature = decodeBase64(signWithMachineKey(pair.privateKey, message))!;
    const publicKey = decodeBase64(pair.publicKey)!;
    expect(ed25519Verify(message, signature, publicKey)).toBe(true);
    expect(ed25519Verify(new TextEncoder().encode('hellp'), signature, publicKey)).toBe(false);
    expect(ed25519Verify(message, signature, new Uint8Array([1, 2, 3]))).toBe(false);
  });
});
