/**
 * G2 ruling 4 (2026-09-21, point guard) — the pending-write digest is an HMAC
 * keyed by a PLANE-HELD key that never enters the main DB or the web process.
 *
 * Why: the plane metadata row carries `pending_digest` for as long as a write
 * is ambiguous (ADR 0005 §2.3). An UNKEYED hash of `{ secretValue,
 * secretComment }` is a dictionary oracle: anyone who can read that row and
 * knows (or can enumerate) the likely material — a leaked key list, a
 * provider's key format with a short random tail, the previous value plus one
 * character — recovers the plaintext by hashing candidates until one matches.
 * The first describe block below demonstrates that attack against the unkeyed
 * scheme; the second pins that the keyed scheme defeats it.
 */
import { describe, expect, it } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { canonicalJson } from '../../canonical-json';
import type { HmacBytes, WriteDigestKey } from '../store-adapter';
import { digestWrite } from '../digest-write';

const sha3 = (bytes: Uint8Array): string => createHash('sha3-256').update(bytes).digest('hex');
const hmacSha3: HmacBytes = (key, bytes) => createHmac('sha3-256', key).update(bytes).digest('hex');
const keyOf = (fill: number) => new Uint8Array(32).fill(fill) as WriteDigestKey;

const bindingsComment = JSON.stringify({ tenantId: 'user:u1', kind: 'api_key' });
const valueFor = (apiKey: string) => JSON.stringify({ kind: 'api_key', material: { value: apiKey, placement: { in: 'header', name: 'x-api-key' } } });

// The attacker's view: a leaked list, or a key format whose unknown tail is small.
const candidates = Array.from({ length: 256 }, (_, index) => `sk_live_${index.toString(16).padStart(2, '0')}`);
const secretKey = 'sk_live_a7';

/** What a metadata reader does with a digest: hash every candidate the unkeyed way and look for a match. */
function dictionaryAttack(observedDigest: string): string | null {
  for (const candidate of candidates) {
    const guess = sha3(new TextEncoder().encode(canonicalJson({ secretValue: valueFor(candidate), secretComment: bindingsComment })));
    if (guess === observedDigest) return candidate;
  }
  return null;
}

describe('the unkeyed write digest (the defect ruling 4 removes)', () => {
  it('given only the metadata row and a known candidate set, should let a reader recover the stored API key', () => {
    const unkeyed = sha3(new TextEncoder().encode(canonicalJson({ secretValue: valueFor(secretKey), secretComment: bindingsComment })));
    const actual = dictionaryAttack(unkeyed);
    const expected = secretKey;
    expect(actual).toEqual(expected);
  });
});

describe('digestWrite — HMAC under the plane-held key (G2 ruling 4)', () => {
  it('given the same candidate set, should give a metadata reader without the plane key nothing to match', () => {
    const digest = digestWrite({ secretValue: valueFor(secretKey), secretComment: bindingsComment, key: keyOf(7), hmac: hmacSha3 });
    const actual = dictionaryAttack(digest);
    const expected = null;
    expect(actual).toEqual(expected);
  });

  it('given a write, should be the injected HMAC under the plane key over canonicalJson of value and comment', () => {
    const actual = digestWrite({ secretValue: 'v', secretComment: 'c', key: keyOf(1), hmac: hmacSha3 });
    const expected = hmacSha3(keyOf(1), new TextEncoder().encode(canonicalJson({ secretValue: 'v', secretComment: 'c' })));
    expect(actual).toEqual(expected);
  });

  it('given the same write under two different plane keys, should digest differently', () => {
    const actual = digestWrite({ secretValue: 'v', secretComment: 'c', key: keyOf(1), hmac: hmacSha3 }) === digestWrite({ secretValue: 'v', secretComment: 'c', key: keyOf(2), hmac: hmacSha3 });
    const expected = false;
    expect(actual).toEqual(expected);
  });

  it('given writes that differ only in value, only in comment, or that swap the two, should digest differently', () => {
    const key = keyOf(3);
    const base = digestWrite({ secretValue: 'a', secretComment: 'b', key, hmac: hmacSha3 });
    const actual = [
      digestWrite({ secretValue: 'a2', secretComment: 'b', key, hmac: hmacSha3 }) === base,
      digestWrite({ secretValue: 'a', secretComment: 'b2', key, hmac: hmacSha3 }) === base,
      digestWrite({ secretValue: 'b', secretComment: 'a', key, hmac: hmacSha3 }) === base,
    ];
    const expected = [false, false, false];
    expect(actual).toEqual(expected);
  });
});
