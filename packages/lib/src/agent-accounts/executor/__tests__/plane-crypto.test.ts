import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { hmacSha3_256, planeCryptoSelfCheck } from '../plane-crypto';

const bytes = (length: number, seed: number) => Uint8Array.from({ length }, (_, index) => (index * 31 + seed) % 256);
const nodeHmac = (key: Uint8Array, message: Uint8Array) => createHmac('sha3-256', key).update(message).digest('hex');

describe('hmacSha3_256', () => {
  it('given keys shorter than, equal to and longer than the 136-byte block, should match Node createHmac byte for byte', () => {
    const cases = [0, 1, 32, 135, 136, 137, 300].map((keyLength) => ({ key: bytes(keyLength, 7), message: bytes(keyLength + 13, 3) }));
    const actual = cases.map(({ key, message }) => hmacSha3_256(key, message));
    const expected = cases.map(({ key, message }) => nodeHmac(key, message));
    expect(actual).toEqual(expected);
  });

  it('given an empty message, should match Node createHmac', () => {
    const key = bytes(32, 1);
    expect(hmacSha3_256(key, new Uint8Array(0))).toBe(nodeHmac(key, new Uint8Array(0)));
  });
});

describe('planeCryptoSelfCheck', () => {
  it('given a runtime whose primitives give their known answers, should report no failures', () => {
    expect(planeCryptoSelfCheck()).toEqual([]);
  });
});
