/**
 * ADR 0004 §2.4 + §8.11 — the replay decision over the ledger's facts.
 *
 * Written RED at G1b before `decide-replay.ts` existed. The verifier never
 * touches the replay store: the adapter looks the nonce up, THIS function
 * turns what it found into the `NonceState` the verifier consumes, and the
 * adapter records the nonce only after the whole verdict is `ok`.
 */
import { describe, it, expect } from 'vitest';
import { decideReplay } from '../decide-replay';

const NOW = 1_800_000_000_000;

describe('decideReplay', () => {
  it('given no recorded row for the nonce, should report fresh', () => {
    const actual = decideReplay({ lookup: { ok: true, recorded: null }, now: NOW });
    expect(actual).toBe('fresh');
  });

  it('given a recorded row for the nonce, should report consumed', () => {
    const actual = decideReplay({ lookup: { ok: true, recorded: { grantId: 'g1', expiresAt: NOW + 60_000, consumedAt: NOW - 1_000 } }, now: NOW });
    expect(actual).toBe('consumed');
  });

  it('given a recorded row whose grant has since expired, should still report consumed (a ledger entry is never un-spent by time)', () => {
    const actual = decideReplay({ lookup: { ok: true, recorded: { grantId: 'g1', expiresAt: NOW - 1, consumedAt: NOW - 60_000 } }, now: NOW });
    expect(actual).toBe('consumed');
  });

  it('given the lookup failed (store unreachable), should report unknown — never assume fresh [0004 §8.11]', () => {
    const actual = decideReplay({ lookup: { ok: false }, now: NOW });
    expect(actual).toBe('unknown');
  });

  it('given the same facts twice, should return the same state (pure)', () => {
    const input = { lookup: { ok: true as const, recorded: null }, now: NOW };
    const actual = [decideReplay(input), decideReplay(input)];
    expect(actual).toEqual(['fresh', 'fresh']);
  });
});
