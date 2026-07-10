/**
 * Golden-vector + property suite for the anchor pure core (#890 Phase 2,
 * leaf 3).
 *
 * An anchor is a signed statement "at chain_seq S the head was H, at time T"
 * published to stores the Admin PG credentials cannot touch (S3 Object-Lock
 * WORM + the anchor-receipt table). These tests pin:
 *   - the canonical payload bytes (stableStringify, sorted keys)
 *   - the HMAC-SHA256 signature as LITERAL hex — if a pinned vector ever
 *     fails, anchor semantics changed and every anchor already published to
 *     the WORM store no longer verifies against a recomputation
 *   - the anchor-match verdicts the dual-era full verifier (backfill leaf)
 *     consumes: match / hash_mismatch / seq_gap / unverifiable
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';

import {
  ANCHOR_VERSION,
  ANCHOR_SOURCE,
  buildAnchorPayload,
  canonicalAnchorContent,
  serializeSignedAnchor,
  verifyAnchorSignature,
  matchAnchorsAgainstChain,
  type SignedAnchor,
} from '../anchor';
import { computeChainHash, GENESIS_PREVIOUS_HASH } from '../chain-step';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ————— Pinned vectors (computed once from the canonical formula) —————
const HEAD_1 = '71a0b19471f8217d02dc7f3bc837604edd727727e914a12e60cfda7b2dccdf5c';
const HEAD_2 = 'f710123696cee3d4d774e3a40be86cfe230e1a71de8c83e3de9460f327178be3';
const V1_SECRET = 'anchor-secret-alpha';
const V1_CANONICAL =
  '{"anchoredAt":"2026-02-01T00:00:00.000Z","chainSeq":1,"head":"71a0b19471f8217d02dc7f3bc837604edd727727e914a12e60cfda7b2dccdf5c","source":"pagespace-audit-chain","version":1}';
const V1_SIGNATURE = 'de8a4c43af47b1856d3fb492972168eab4705ae32784b8ff2621d6ceafb045e8';
const V1_SERIALIZED =
  '{"anchoredAt":"2026-02-01T00:00:00.000Z","chainSeq":1,"head":"71a0b19471f8217d02dc7f3bc837604edd727727e914a12e60cfda7b2dccdf5c","signature":"de8a4c43af47b1856d3fb492972168eab4705ae32784b8ff2621d6ceafb045e8","source":"pagespace-audit-chain","version":1}';
const V2_SIGNATURE = '39573db3446f7ea1340b477266cd644835bdfb97bdfb739e9d18992cba68591d';

const v1Input = {
  head: HEAD_1,
  chainSeq: 1,
  anchoredAt: new Date('2026-02-01T00:00:00.000Z'),
  secret: V1_SECRET,
};

describe('buildAnchorPayload golden vectors (pinned)', () => {
  it('given the v1 input, should produce the pinned canonical payload and HMAC-SHA256 signature', () => {
    const anchor = buildAnchorPayload(v1Input);

    expect(anchor).toEqual({
      version: ANCHOR_VERSION,
      source: ANCHOR_SOURCE,
      chainSeq: 1,
      head: HEAD_1,
      anchoredAt: '2026-02-01T00:00:00.000Z',
      signature: V1_SIGNATURE,
    });
    expect(canonicalAnchorContent(anchor)).toBe(V1_CANONICAL);
  });

  it('given a large chainSeq and millisecond timestamp, should match the pinned signature', () => {
    const anchor = buildAnchorPayload({
      head: HEAD_2,
      chainSeq: 987654321,
      anchoredAt: new Date('2026-02-15T12:34:56.789Z'),
      secret: 'anchor-secret-beta',
    });

    expect(anchor.signature).toBe(V2_SIGNATURE);
  });

  it('given the same input twice, should be deterministic (no ambient clock or randomness)', () => {
    expect(buildAnchorPayload(v1Input)).toEqual(buildAnchorPayload(v1Input));
  });

  it('given any single differing field, should produce a different signature', () => {
    const base = buildAnchorPayload(v1Input).signature;

    expect(buildAnchorPayload({ ...v1Input, head: HEAD_2 }).signature).not.toBe(base);
    expect(buildAnchorPayload({ ...v1Input, chainSeq: 2 }).signature).not.toBe(base);
    expect(
      buildAnchorPayload({ ...v1Input, anchoredAt: new Date('2026-02-01T00:00:00.001Z') }).signature,
    ).not.toBe(base);
    expect(buildAnchorPayload({ ...v1Input, secret: 'other-secret' }).signature).not.toBe(base);
  });
});

describe('serializeSignedAnchor', () => {
  it('given the v1 anchor, should serialize to the pinned canonical bytes (the exact WORM object body)', () => {
    const anchor = buildAnchorPayload(v1Input);

    expect(serializeSignedAnchor(anchor)).toBe(V1_SERIALIZED);
  });

  it('given a serialized anchor round-tripped through JSON, should verify (publish → fetch → verify)', () => {
    const anchor = buildAnchorPayload(v1Input);
    const roundTripped = JSON.parse(serializeSignedAnchor(anchor)) as SignedAnchor;

    expect(verifyAnchorSignature(roundTripped, V1_SECRET)).toBe(true);
  });
});

describe('verifyAnchorSignature', () => {
  const anchor = buildAnchorPayload(v1Input);

  it('given an untampered anchor and the right secret, should verify', () => {
    expect(verifyAnchorSignature(anchor, V1_SECRET)).toBe(true);
  });

  it('given the wrong secret, should reject', () => {
    expect(verifyAnchorSignature(anchor, 'wrong-secret')).toBe(false);
  });

  it('given any tampered content field, should reject', () => {
    expect(verifyAnchorSignature({ ...anchor, head: HEAD_2 }, V1_SECRET)).toBe(false);
    expect(verifyAnchorSignature({ ...anchor, chainSeq: 2 }, V1_SECRET)).toBe(false);
    expect(
      verifyAnchorSignature({ ...anchor, anchoredAt: '2026-02-01T00:00:00.001Z' }, V1_SECRET),
    ).toBe(false);
    expect(verifyAnchorSignature({ ...anchor, version: 2 }, V1_SECRET)).toBe(false);
    expect(verifyAnchorSignature({ ...anchor, source: 'evil' }, V1_SECRET)).toBe(false);
  });

  it('given a tampered signature (every single-hex-digit mutation of the first 8 chars), should reject', () => {
    // Property-style sweep: no prefix of a valid signature is accepted.
    for (let i = 0; i < 8; i++) {
      const flipped =
        anchor.signature.slice(0, i) +
        (anchor.signature[i] === '0' ? '1' : '0') +
        anchor.signature.slice(i + 1);
      expect(verifyAnchorSignature({ ...anchor, signature: flipped }, V1_SECRET)).toBe(false);
    }
  });

  it('given randomized inputs, build → verify should always round-trip (property)', () => {
    for (let i = 0; i < 50; i++) {
      const built = buildAnchorPayload({
        head: sha256(`head-${i}`),
        chainSeq: i * 7919 + 1,
        anchoredAt: new Date(Date.UTC(2026, i % 12, (i % 27) + 1, i % 24, i % 60, i % 60, i * 13 % 1000)),
        secret: `secret-${i}`,
      });
      expect(verifyAnchorSignature(built, `secret-${i}`)).toBe(true);
      expect(verifyAnchorSignature(built, `secret-${i + 1}`)).toBe(false);
    }
  });
});

describe('matchAnchorsAgainstChain', () => {
  const secret = 'match-secret';
  const anchorAt = (chainSeq: number, head: string, at = '2026-03-01T00:00:00.000Z') =>
    buildAnchorPayload({ head, chainSeq, anchoredAt: new Date(at), secret });

  // A tiny real chain built with the leaf-2 pure core, so anchor-match is
  // proven against genuine chain hashes rather than synthetic strings.
  const e1 = sha256('emission-1');
  const e2 = sha256('emission-2');
  const e3 = sha256('emission-3');
  const h1 = computeChainHash(e1, GENESIS_PREVIOUS_HASH);
  const h2 = computeChainHash(e2, h1);
  const h3 = computeChainHash(e3, h2);
  const chain = new Map<number, string>([
    [1, h1],
    [2, h2],
    [3, h3],
  ]);

  it('given anchors matching the chain at every anchored seq, should report match for each and allMatch', () => {
    const report = matchAnchorsAgainstChain([anchorAt(1, h1), anchorAt(3, h3)], chain, secret);

    expect(report.allMatch).toBe(true);
    expect(report.results).toEqual([
      { chainSeq: 1, verdict: 'match', anchorHead: h1, chainHead: h1 },
      { chainSeq: 3, verdict: 'match', anchorHead: h3, chainHead: h3 },
    ]);
    expect(report.counts).toEqual({ match: 2, hash_mismatch: 0, seq_gap: 0, unverifiable: 0 });
  });

  it('given an anchor whose head differs from the chain row at that seq, should report hash_mismatch (tamper signal)', () => {
    const report = matchAnchorsAgainstChain([anchorAt(2, sha256('forged-head'))], chain, secret);

    expect(report.allMatch).toBe(false);
    expect(report.results[0]).toEqual({
      chainSeq: 2,
      verdict: 'hash_mismatch',
      anchorHead: sha256('forged-head'),
      chainHead: h2,
    });
  });

  it('given an anchor at a seq the chain has no row for, should report seq_gap (rows missing below an anchored head)', () => {
    const report = matchAnchorsAgainstChain([anchorAt(7, sha256('beyond'))], chain, secret);

    expect(report.allMatch).toBe(false);
    expect(report.results[0]).toEqual({
      chainSeq: 7,
      verdict: 'seq_gap',
      anchorHead: sha256('beyond'),
      chainHead: null,
    });
  });

  it('given an anchor whose signature does not verify, should report unverifiable WITHOUT consulting the chain', () => {
    const forged: SignedAnchor = { ...anchorAt(1, h1), signature: '0'.repeat(64) };
    let lookups = 0;

    const report = matchAnchorsAgainstChain(
      [forged],
      (seq) => {
        lookups++;
        return chain.get(seq) ?? null;
      },
      secret,
    );

    expect(report.results[0]).toEqual({
      chainSeq: 1,
      verdict: 'unverifiable',
      anchorHead: h1,
      chainHead: null,
    });
    expect(lookups).toBe(0);
    expect(report.allMatch).toBe(false);
  });

  it('given an anchor signed with a different secret, should report unverifiable (rotated/unknown key)', () => {
    const otherKey = buildAnchorPayload({
      head: h1,
      chainSeq: 1,
      anchoredAt: new Date('2026-03-01T00:00:00.000Z'),
      secret: 'rotated-away',
    });

    const report = matchAnchorsAgainstChain([otherKey], chain, secret);

    expect(report.results[0].verdict).toBe('unverifiable');
  });

  it('given a mixed set in unsorted order, should return results sorted by chainSeq with per-verdict counts', () => {
    const report = matchAnchorsAgainstChain(
      [
        anchorAt(3, h3), // match
        { ...anchorAt(1, h1), signature: 'f'.repeat(64) }, // unverifiable
        anchorAt(9, sha256('x')), // seq_gap
        anchorAt(2, sha256('y')), // hash_mismatch
      ],
      chain,
      secret,
    );

    expect(report.results.map((r) => r.chainSeq)).toEqual([1, 2, 3, 9]);
    expect(report.results.map((r) => r.verdict)).toEqual([
      'unverifiable',
      'hash_mismatch',
      'match',
      'seq_gap',
    ]);
    expect(report.counts).toEqual({ match: 1, hash_mismatch: 1, seq_gap: 1, unverifiable: 1 });
    expect(report.allMatch).toBe(false);
  });

  it('given no anchors at all, should NOT report allMatch (an unwitnessed chain is unverified, not verified)', () => {
    const report = matchAnchorsAgainstChain([], chain, secret);

    expect(report.allMatch).toBe(false);
    expect(report.results).toEqual([]);
    expect(report.counts).toEqual({ match: 0, hash_mismatch: 0, seq_gap: 0, unverifiable: 0 });
  });

  it('given a function lookup and a Map lookup over the same chain, should produce identical reports', () => {
    const anchors = [anchorAt(1, h1), anchorAt(2, h2), anchorAt(3, h3)];

    const viaMap = matchAnchorsAgainstChain(anchors, chain, secret);
    const viaFn = matchAnchorsAgainstChain(anchors, (seq) => chain.get(seq) ?? null, secret);

    expect(viaFn).toEqual(viaMap);
    expect(viaMap.allMatch).toBe(true);
  });

  it('given anchors generated across a growing synthetic chain, should all match (property: anchoring every head is consistent)', () => {
    let prev = GENESIS_PREVIOUS_HASH;
    const lookup = new Map<number, string>();
    const anchors: SignedAnchor[] = [];
    for (let seq = 1; seq <= 40; seq++) {
      prev = computeChainHash(sha256(`e-${seq}`), prev);
      lookup.set(seq, prev);
      anchors.push(anchorAt(seq, prev, `2026-03-01T00:00:${String(seq % 60).padStart(2, '0')}.000Z`));
    }

    const report = matchAnchorsAgainstChain(anchors, lookup, secret);

    expect(report.allMatch).toBe(true);
    expect(report.counts.match).toBe(40);
  });
});
