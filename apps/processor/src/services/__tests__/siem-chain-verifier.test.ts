import { describe, it } from 'vitest';
import { assert } from '../../__tests__/riteway';
import {
  verifyChainForSource,
  type ChainVerifiableEntry,
} from '../siem-chain-verifier';

// Synthetic test entries — the verifier only reads id/logHash/previousLogHash,
// so tests don't need the full AuditLogEntry shape. The recomputeHash strategy
// is injected, so tests can use trivial deterministic fake hashers instead of
// running real SHA-256 (which is covered by the hashers' own round-trip tests).
function entry(
  id: string,
  logHash: string | null,
  previousLogHash: string | null
): ChainVerifiableEntry {
  return { id, logHash, previousLogHash };
}

// A fake strategy: "correct" hash for entry X given prev P is literally `hash(X|P)`.
// So a chain of e1..e3 anchored on 'ANCHOR' has:
//   e1.logHash = 'hash(e1|ANCHOR)'
//   e2.logHash = 'hash(e2|hash(e1|ANCHOR))'
// etc. This lets tests compose expected chains without touching crypto.
const fakeHasher =
  (entry: ChainVerifiableEntry, previousHash: string): string =>
    `hash(${entry.id}|${previousHash})`;

describe('verifyChainForSource', () => {
  it('empty batch is trivially valid', () => {
    const result = verifyChainForSource({
      anchorHash: 'ANCHOR',
      entries: [],
      recomputeHash: fakeHasher,
    });

    assert({
      given: 'an empty entries array',
      should: 'return valid with verifiedCount 0',
      actual: result,
      expected: { valid: true, verifiedCount: 0 },
    });
  });

  it('single entry whose previousLogHash matches anchorHash and recomputes cleanly', () => {
    const e1 = entry('e1', 'hash(e1|ANCHOR)', 'ANCHOR');

    const result = verifyChainForSource({
      anchorHash: 'ANCHOR',
      entries: [e1],
      recomputeHash: fakeHasher,
    });

    assert({
      given: 'a single entry whose previousLogHash matches anchorHash and whose logHash recomputes cleanly',
      should: 'return valid with verifiedCount 1',
      actual: result,
      expected: { valid: true, verifiedCount: 1 },
    });
  });

  it('single entry whose previousLogHash does not match anchorHash', () => {
    // previousLogHash is a stale anchor — chain is broken at entry 0
    const e1 = entry('e1', 'hash(e1|STALE)', 'STALE');

    const result = verifyChainForSource({
      anchorHash: 'ANCHOR',
      entries: [e1],
      recomputeHash: fakeHasher,
    });

    assert({
      given: 'a single entry whose previousLogHash does not match anchorHash',
      should: 'return invalid at index 0 with chain_break',
      actual: result,
      expected: {
        valid: false,
        verifiedCount: 0,
        breakAtIndex: 0,
        breakReason: 'chain_break',
        expectedHash: 'ANCHOR',
        actualHash: 'STALE',
      },
    });
  });

  it('single entry whose recomputed hash does not match stored logHash (tamper case)', () => {
    // previousLogHash links to anchor correctly, but logHash itself has been
    // rewritten by an attacker — recompute produces a different value.
    const e1 = entry('e1', 'TAMPERED_HASH', 'ANCHOR');

    const result = verifyChainForSource({
      anchorHash: 'ANCHOR',
      entries: [e1],
      recomputeHash: fakeHasher,
    });

    assert({
      given: "a single entry whose recomputed hash does not match the stored logHash",
      should: 'return invalid at index 0 with hash_mismatch',
      actual: result,
      expected: {
        valid: false,
        verifiedCount: 0,
        breakAtIndex: 0,
        breakReason: 'hash_mismatch',
        expectedHash: 'hash(e1|ANCHOR)',
        actualHash: 'TAMPERED_HASH',
      },
    });
  });

  it('single entry with null logHash', () => {
    const e1 = entry('e1', null, 'ANCHOR');

    const result = verifyChainForSource({
      anchorHash: 'ANCHOR',
      entries: [e1],
      recomputeHash: fakeHasher,
    });

    assert({
      given: 'a single entry with null logHash',
      should: 'return invalid at index 0 with missing_hash',
      actual: result,
      expected: {
        valid: false,
        verifiedCount: 0,
        breakAtIndex: 0,
        breakReason: 'missing_hash',
        expectedHash: 'hash(e1|ANCHOR)',
        actualHash: null,
      },
    });
  });

  it('chain of three entries where entry 2 does not link to entry 1', () => {
    const e1 = entry('e1', 'hash(e1|ANCHOR)', 'ANCHOR');
    const e2 = entry('e2', 'hash(e2|hash(e1|ANCHOR))', 'hash(e1|ANCHOR)');
    // e3.previousLogHash should be e2.logHash but isn't — chain break at index 2
    const e3 = entry('e3', 'hash(e3|WRONG_LINK)', 'WRONG_LINK');

    const result = verifyChainForSource({
      anchorHash: 'ANCHOR',
      entries: [e1, e2, e3],
      recomputeHash: fakeHasher,
    });

    assert({
      given: "a chain of three entries where entry 2's previousLogHash does not match entry 1's logHash",
      should: 'return invalid at breakAtIndex 2 with chain_break and verifiedCount 2',
      actual: result,
      expected: {
        valid: false,
        verifiedCount: 2,
        breakAtIndex: 2,
        breakReason: 'chain_break',
        expectedHash: 'hash(e2|hash(e1|ANCHOR))',
        actualHash: 'WRONG_LINK',
      },
    });
  });

  it('chain of three entries where entry 1 has a tampered logHash', () => {
    const e1 = entry('e1', 'hash(e1|ANCHOR)', 'ANCHOR');
    // e2 stores a rewritten logHash that does not match recomputeHash output.
    const e2 = entry('e2', 'TAMPERED', 'hash(e1|ANCHOR)');
    const e3 = entry('e3', 'hash(e3|anything)', 'TAMPERED');

    const result = verifyChainForSource({
      anchorHash: 'ANCHOR',
      entries: [e1, e2, e3],
      recomputeHash: fakeHasher,
    });

    assert({
      given: "a chain of three entries where entry 1's recomputed hash mismatches",
      should: 'return invalid at breakAtIndex 1 with hash_mismatch and verifiedCount 1',
      actual: result,
      expected: {
        valid: false,
        verifiedCount: 1,
        breakAtIndex: 1,
        breakReason: 'hash_mismatch',
        expectedHash: 'hash(e2|hash(e1|ANCHOR))',
        actualHash: 'TAMPERED',
      },
    });
  });

  it('fresh init (anchorHash null) with a valid internal chain skips anchor check', () => {
    // previousLogHash on entry 0 is whatever the write-side chose (a chain seed,
    // 'genesis', or a random start). Verifier can't validate it — only the
    // internal chain matters here.
    const e1 = entry('e1', 'hash(e1|SEED_42)', 'SEED_42');
    const e2 = entry('e2', 'hash(e2|hash(e1|SEED_42))', 'hash(e1|SEED_42)');

    const result = verifyChainForSource({
      anchorHash: null,
      entries: [e1, e2],
      recomputeHash: fakeHasher,
    });

    assert({
      given: 'a fresh init (anchorHash null) and a valid internal chain',
      should: 'return valid and skip the anchor check on entry 0',
      actual: result,
      expected: { valid: true, verifiedCount: 2 },
    });
  });

  it('fresh init (anchorHash null) with entry 0 previousLogHash null', () => {
    // A genesis-style first entry: previousLogHash is null because the caller
    // encoded the chain start differently. Verifier must not fail on null here.
    const e1 = entry('e1', 'hash(e1|)', null);

    const result = verifyChainForSource({
      anchorHash: null,
      entries: [e1],
      recomputeHash: (entry, prev) => `hash(${entry.id}|${prev})`,
    });

    assert({
      given: 'a fresh init (anchorHash null) and entry 0 with a null previousLogHash',
      should: 'return valid (fresh chain start)',
      actual: result,
      expected: { valid: true, verifiedCount: 1 },
    });
  });
});
