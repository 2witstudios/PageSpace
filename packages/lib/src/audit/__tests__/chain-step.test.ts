/**
 * Golden-vector + property suite for the pure chainer core (#890 Phase 2, leaf 2).
 *
 * chainHash = H(emissionHash, prevHash): sha256 over stableStringify of
 * EXACTLY those two fields. These vectors pin the chain-step semantics the
 * single-writer chainer worker relies on — if this suite ever fails, every
 * chained row already written no longer verifies against a recomputation.
 *
 * The emission-hash inputs reuse the pinned vectors from emission-hash.test.ts
 * so the two suites together pin the full emission → chain pipeline.
 */
import { describe, it, expect } from 'vitest';

import {
  computeChainHash,
  assignChainBatch,
  verifyAppendedSegment,
  GENESIS_PREVIOUS_HASH,
  type ChainableIngestRow,
} from '../chain-step';

// Pinned emission hashes (from emission-hash.test.ts golden vectors).
const EMISSION_MINIMAL = '7b3bd93e3b22380b60bed2ea1dfff9aa72b0281a969a44ab2a8b77db9a8bc1c8';
const EMISSION_DETAILS = 'bb51071ec93aa6e42a169d0584c01ba3a210e8ad83546b14bc1215767fee7e55';
const EMISSION_ALL_FIELDS = '8b5ae1d30aa91211ac8df78efce42c3700101ee5714516709ec9bf9c2d1697d8';

// Pinned chain-step outputs (literal hex — never recompute these in-test).
const GENESIS_STEP = '45362581a9ee89d1d0edea1b93f365f36cd5852b950dfe41398537d68a31f77e';
const SECOND_STEP = 'c1cffb8442bbb89dce1830da98141a41fd73fbdf5ccf40897a300ea1efd61d8d';
const THIRD_STEP = 'abbb75afebf9c7fea40e9e767601ec191fa3823648ddea9b4d307cf1e6364852';
// A cutover-shaped step: prevHash is an arbitrary legacy chain head, not
// 'genesis' — the backfill leaf supplies that anchor; the fn just takes it.
const LEGACY_HEAD = 'a3f1c2d4e5b6978810213243546576879809aabbccddeeff0011223344556677';
const LEGACY_ANCHOR_STEP = '88e49d230ef72c5ae98565eb42312029470d85b29e03490e640336f7cae68f91';

/** Deterministic pseudo-random ingest rows (seeded LCG — no Math.random). */
function makeIngestRows(count: number, seed = 42): ChainableIngestRow[] {
  let state = seed;
  const next = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  return Array.from({ length: count }, (_, i) => ({
    id: `ingest-${seed}-${i}`,
    eventType: (['auth.login.success', 'data.read', 'data.write', 'authz.access.denied'] as const)[
      Math.floor(next() * 4)
    ],
    userId: next() > 0.5 ? `user-${Math.floor(next() * 100)}` : null,
    sessionId: next() > 0.5 ? `sess-${Math.floor(next() * 100)}` : null,
    serviceId: 'web',
    resourceType: next() > 0.5 ? 'page' : null,
    resourceId: next() > 0.5 ? `res-${Math.floor(next() * 100)}` : null,
    ipAddress: next() > 0.5 ? `ciphertext-${i}` : null,
    ipBidx: next() > 0.5 ? `bidx-${i}` : null,
    userAgent: null,
    geoLocation: null,
    details: next() > 0.5 ? { step: i, nested: { flag: next() > 0.5 } } : null,
    riskScore: next() > 0.7 ? Math.floor(next() * 100) / 100 : null,
    anomalyFlags: next() > 0.8 ? ['brute_force'] : null,
    timestamp: new Date(Date.UTC(2026, 0, 25, 10, 0, i)),
    emissionHash: `${'0'.repeat(56)}${(seed * 1000 + i).toString(16).padStart(8, '0')}`,
  }));
}

describe('computeChainHash golden vectors (pinned)', () => {
  it('given the minimal emission hash and the genesis sentinel, should match the pinned hash', () => {
    expect(computeChainHash(EMISSION_MINIMAL, GENESIS_PREVIOUS_HASH)).toBe(GENESIS_STEP);
  });

  it('given each successive emission hash and the previous chain hash, should match the pinned chain', () => {
    expect(computeChainHash(EMISSION_DETAILS, GENESIS_STEP)).toBe(SECOND_STEP);
    expect(computeChainHash(EMISSION_ALL_FIELDS, SECOND_STEP)).toBe(THIRD_STEP);
  });

  it('given a legacy chain head as prevHash (cutover anchor shape), should match the pinned hash', () => {
    expect(computeChainHash(EMISSION_MINIMAL, LEGACY_HEAD)).toBe(LEGACY_ANCHOR_STEP);
  });

  it('given swapped arguments, should NOT produce the same hash (fields are named, not positional)', () => {
    expect(computeChainHash(GENESIS_STEP, EMISSION_MINIMAL)).not.toBe(
      computeChainHash(EMISSION_MINIMAL, GENESIS_STEP),
    );
  });

  it('given a different previous hash for the same emission hash, should produce a different chain hash', () => {
    expect(computeChainHash(EMISSION_MINIMAL, GENESIS_STEP)).not.toBe(GENESIS_STEP);
    expect(computeChainHash(EMISSION_MINIMAL, 'genesis')).toBe(GENESIS_STEP);
  });

  it('should export the same genesis sentinel the legacy advisory-lock chain uses', () => {
    expect(GENESIS_PREVIOUS_HASH).toBe('genesis');
  });
});

describe('assignChainBatch', () => {
  it('given an empty batch, should return no payloads and the unchanged head (identity)', () => {
    const head = { prevHash: LEGACY_HEAD };

    const result = assignChainBatch([], head);

    expect(result.chainedRowPayloads).toEqual([]);
    expect(result.newHead).toEqual({ prevHash: LEGACY_HEAD });
  });

  it('given ordered rows, should link row N previous_hash to row N-1 event_hash (linkage property)', () => {
    const rows = makeIngestRows(50);

    const { chainedRowPayloads, newHead } = assignChainBatch(rows, {
      prevHash: GENESIS_PREVIOUS_HASH,
    });

    expect(chainedRowPayloads).toHaveLength(50);
    expect(chainedRowPayloads[0].previousHash).toBe(GENESIS_PREVIOUS_HASH);
    for (let i = 1; i < chainedRowPayloads.length; i++) {
      expect(chainedRowPayloads[i].previousHash).toBe(chainedRowPayloads[i - 1].eventHash);
    }
    expect(newHead.prevHash).toBe(chainedRowPayloads[chainedRowPayloads.length - 1].eventHash);
  });

  it('given the same rows and head twice, should produce identical output (determinism property)', () => {
    const head = { prevHash: LEGACY_HEAD };

    const first = assignChainBatch(makeIngestRows(25, 7), head);
    const second = assignChainBatch(makeIngestRows(25, 7), head);

    expect(second).toEqual(first);
  });

  it('given each payload, should carry emission_hash unchanged and event_hash = computeChainHash(emissionHash, previousHash)', () => {
    const rows = makeIngestRows(20, 99);

    const { chainedRowPayloads } = assignChainBatch(rows, { prevHash: GENESIS_PREVIOUS_HASH });

    for (let i = 0; i < rows.length; i++) {
      const payload = chainedRowPayloads[i];
      expect(payload.emissionHash).toBe(rows[i].emissionHash);
      expect(payload.eventHash).toBe(computeChainHash(payload.emissionHash, payload.previousHash));
    }
  });

  it('given ingest rows, should copy every event column onto the payload verbatim (id included)', () => {
    const [row] = makeIngestRows(1, 3);

    const { chainedRowPayloads } = assignChainBatch([row], { prevHash: GENESIS_PREVIOUS_HASH });
    const [payload] = chainedRowPayloads;

    expect(payload.id).toBe(row.id);
    expect(payload.eventType).toBe(row.eventType);
    expect(payload.userId).toBe(row.userId);
    expect(payload.sessionId).toBe(row.sessionId);
    expect(payload.serviceId).toBe(row.serviceId);
    expect(payload.resourceType).toBe(row.resourceType);
    expect(payload.resourceId).toBe(row.resourceId);
    expect(payload.ipAddress).toBe(row.ipAddress);
    expect(payload.ipBidx).toBe(row.ipBidx);
    expect(payload.userAgent).toBe(row.userAgent);
    expect(payload.geoLocation).toBe(row.geoLocation);
    expect(payload.details).toEqual(row.details);
    expect(payload.riskScore).toBe(row.riskScore);
    expect(payload.anomalyFlags).toEqual(row.anomalyFlags);
    expect(payload.timestamp).toEqual(row.timestamp);
  });

  it('given a batch starting from a previous batch head, should continue the chain seamlessly (batch-boundary property)', () => {
    const rows = makeIngestRows(30, 11);

    const whole = assignChainBatch(rows, { prevHash: GENESIS_PREVIOUS_HASH });
    const firstHalf = assignChainBatch(rows.slice(0, 15), { prevHash: GENESIS_PREVIOUS_HASH });
    const secondHalf = assignChainBatch(rows.slice(15), firstHalf.newHead);

    expect([...firstHalf.chainedRowPayloads, ...secondHalf.chainedRowPayloads]).toEqual(
      whole.chainedRowPayloads,
    );
    expect(secondHalf.newHead).toEqual(whole.newHead);
  });

  it('should not mutate the input rows or head (purity)', () => {
    const rows = makeIngestRows(5, 21);
    const snapshot = structuredClone(rows);
    const head = { prevHash: GENESIS_PREVIOUS_HASH };

    assignChainBatch(rows, head);

    expect(rows).toEqual(snapshot);
    expect(head).toEqual({ prevHash: GENESIS_PREVIOUS_HASH });
  });
});

describe('verifyAppendedSegment', () => {
  const assign = (count: number, prevHash: string, seed = 42) =>
    assignChainBatch(makeIngestRows(count, seed), { prevHash });

  it('given a segment produced by assignChainBatch, should verify green (round-trip)', () => {
    const { chainedRowPayloads } = assign(40, GENESIS_PREVIOUS_HASH);

    const result = verifyAppendedSegment(chainedRowPayloads, {
      prevHash: GENESIS_PREVIOUS_HASH,
    });

    expect(result).toEqual({ valid: true, verified: 40 });
  });

  it('given an empty segment, should verify green with zero rows', () => {
    expect(verifyAppendedSegment([], { prevHash: LEGACY_HEAD })).toEqual({
      valid: true,
      verified: 0,
    });
  });

  it('given a tampered emission_hash, should report hash_mismatch at the exact row', () => {
    const { chainedRowPayloads } = assign(10, GENESIS_PREVIOUS_HASH);
    const tampered = chainedRowPayloads.map((row, i) =>
      i === 4 ? { ...row, emissionHash: `${'f'.repeat(64)}` } : row,
    );

    const result = verifyAppendedSegment(tampered, { prevHash: GENESIS_PREVIOUS_HASH });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.breakAtIndex).toBe(4);
      expect(result.entryId).toBe(tampered[4].id);
      expect(result.reason).toBe('hash_mismatch');
      expect(result.expectedHash).toBe(
        computeChainHash(`${'f'.repeat(64)}`, tampered[3].eventHash),
      );
      expect(result.actualHash).toBe(chainedRowPayloads[4].eventHash);
    }
  });

  it('given a broken previous_hash link, should report linkage_break at the exact row', () => {
    const { chainedRowPayloads } = assign(10, GENESIS_PREVIOUS_HASH);
    const tampered = chainedRowPayloads.map((row, i) =>
      i === 6 ? { ...row, previousHash: `${'a'.repeat(64)}` } : row,
    );

    const result = verifyAppendedSegment(tampered, { prevHash: GENESIS_PREVIOUS_HASH });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.breakAtIndex).toBe(6);
      expect(result.reason).toBe('linkage_break');
      expect(result.expectedHash).toBe(tampered[5].eventHash);
      expect(result.actualHash).toBe(`${'a'.repeat(64)}`);
    }
  });

  it('given a NULL emission_hash (legacy-era row shape), should report missing_emission_hash — the chainer never writes those', () => {
    const { chainedRowPayloads } = assign(3, GENESIS_PREVIOUS_HASH);
    const tampered = chainedRowPayloads.map((row, i) =>
      i === 1 ? { ...row, emissionHash: null } : row,
    );

    const result = verifyAppendedSegment(tampered, { prevHash: GENESIS_PREVIOUS_HASH });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.breakAtIndex).toBe(1);
      expect(result.reason).toBe('missing_emission_hash');
    }
  });

  it('given the wrong prior head, should fail at index 0 with linkage_break', () => {
    const { chainedRowPayloads } = assign(5, LEGACY_HEAD);

    const result = verifyAppendedSegment(chainedRowPayloads, {
      prevHash: GENESIS_PREVIOUS_HASH,
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.breakAtIndex).toBe(0);
      expect(result.reason).toBe('linkage_break');
      expect(result.expectedHash).toBe(GENESIS_PREVIOUS_HASH);
      expect(result.actualHash).toBe(LEGACY_HEAD);
    }
  });

  it('given a re-linked but re-hashed tail (attacker rebuilds the chain after the tamper point), should still fail against the prior head... unless the whole segment is consistent — which anchoring (leaf 3) exists to catch', () => {
    // A fully self-consistent forged segment DOES verify against linkage —
    // that is exactly why heads are anchored to an external witness. This
    // test documents the boundary of what verify-on-append can prove.
    const rows = makeIngestRows(5, 77);
    const forged = assignChainBatch(rows, { prevHash: GENESIS_PREVIOUS_HASH });

    const againstRightHead = verifyAppendedSegment(forged.chainedRowPayloads, {
      prevHash: GENESIS_PREVIOUS_HASH,
    });
    const againstWrongHead = verifyAppendedSegment(forged.chainedRowPayloads, {
      prevHash: LEGACY_HEAD,
    });

    expect(againstRightHead.valid).toBe(true);
    expect(againstWrongHead.valid).toBe(false);
  });
});
