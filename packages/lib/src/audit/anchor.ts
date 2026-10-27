/**
 * External anchoring — the pure core (#890 Phase 2, leaf 3).
 *
 * A hash chain whose head lives in the database it protects proves nothing to
 * anyone who doesn't already trust that database: an attacker who owns the
 * Admin PG can rewrite from genesis. An ANCHOR is a signed statement
 * "at chain_seq S the head was H, at time T" published to stores the Admin PG
 * credentials cannot touch (S3 Object-Lock WORM + the append-only
 * security_audit_anchors receipt table). After anchoring, tampering requires
 * compromising app DB + Admin PG + the witness.
 *
 * This module is pure — no I/O, no Date.now, no env. The publisher shells
 * (apps/processor/src/services/anchor-publishers.ts) and the chainer hook do
 * the clocks and writes. Signature semantics are pinned by literal-hex golden
 * vectors in __tests__/anchor.test.ts.
 *
 * Signing: HMAC-SHA256 over stableStringify of the content fields (sorted
 * keys, signature excluded) — the same canonicalization the chain hashes use.
 * Verification recomputes the HMAC over the anchor's OWN content fields
 * (including its stored version/source, so future versions still verify) and
 * compares via secureCompare — the repo's hash-then-compare convention, never
 * raw timingSafeEqual on unhashed values.
 */

import { createHmac } from 'crypto';
import { stableStringify } from '../utils/stable-stringify';
import { secureCompare } from '../auth/secure-compare';

/** Payload format version — bump on any change to the signed field set. */
export const ANCHOR_VERSION = 1;

/** Fixed source marker so a witness store can index anchors among other objects. */
export const ANCHOR_SOURCE = 'pagespace-audit-chain';

/** The signed content fields — everything the signature covers. */
export interface AnchorContent {
  version: number;
  source: string;
  /** chain_seq of the anchored head row. */
  chainSeq: number;
  /** event_hash of the anchored head row. */
  head: string;
  /** Anchor time as an ISO-8601 string (Date is serialized at build time). */
  anchoredAt: string;
}

/** A complete anchor: content plus its HMAC-SHA256 signature (hex). */
export interface SignedAnchor extends AnchorContent {
  signature: string;
}

export interface BuildAnchorPayloadInput {
  head: string;
  chainSeq: number;
  anchoredAt: Date;
  secret: string;
}

/**
 * Canonical bytes of an anchor's CONTENT (signature excluded) — exactly what
 * the HMAC is computed over. Field values are taken from the anchor itself,
 * so anchors from other versions re-canonicalize faithfully.
 */
export function canonicalAnchorContent(anchor: AnchorContent): string {
  const content: AnchorContent = {
    version: anchor.version,
    source: anchor.source,
    chainSeq: anchor.chainSeq,
    head: anchor.head,
    anchoredAt: anchor.anchoredAt,
  };
  return stableStringify(content);
}

/**
 * Build a signed anchor for a chain head. Deterministic: same input, same
 * anchor — the caller supplies the clock.
 */
export function buildAnchorPayload(input: BuildAnchorPayloadInput): SignedAnchor {
  const content: AnchorContent = {
    version: ANCHOR_VERSION,
    source: ANCHOR_SOURCE,
    chainSeq: input.chainSeq,
    head: input.head,
    anchoredAt: input.anchoredAt.toISOString(),
  };

  const signature = createHmac('sha256', input.secret)
    .update(canonicalAnchorContent(content))
    .digest('hex');

  return { ...content, signature };
}

/**
 * Canonical publish form of a signed anchor (sorted keys, signature
 * included) — the exact byte body written to the WORM store, so an object
 * fetched back can be compared byte-for-byte against a recomputation.
 */
export function serializeSignedAnchor(anchor: SignedAnchor): string {
  return stableStringify({ ...anchor });
}

/**
 * Verify an anchor's signature: recompute the HMAC over the anchor's own
 * content fields and hash-compare against the stored signature.
 */
export function verifyAnchorSignature(anchor: SignedAnchor, secret: string): boolean {
  const expected = createHmac('sha256', secret)
    .update(canonicalAnchorContent(anchor))
    .digest('hex');
  return secureCompare(expected, anchor.signature);
}

/**
 * Chain-side lookup: event_hash at a given chain_seq, or null/undefined when
 * the chain has no row at that seq. A Map works for preloaded rows; a
 * function lets the caller wrap any in-memory index.
 */
export type AnchorChainLookup =
  | ReadonlyMap<number, string>
  | ((chainSeq: number) => string | null | undefined);

export type AnchorMatchVerdict =
  /** Chain row exists at the anchored seq and its hash equals the anchored head. */
  | 'match'
  /** Chain row exists but its hash differs — the chain was rewritten (tamper signal). */
  | 'hash_mismatch'
  /** No chain row at the anchored seq — rows below a witnessed head are missing. */
  | 'seq_gap'
  /** The anchor's signature does not verify (forged, corrupted, or rotated key). */
  | 'unverifiable';

export interface AnchorMatchResult {
  chainSeq: number;
  verdict: AnchorMatchVerdict;
  anchorHead: string;
  /** Hash found in the chain at that seq; null when absent or not consulted. */
  chainHead: string | null;
}

export interface AnchorChainMatchReport {
  /**
   * True only when EVERY anchor matched AND at least one anchor exists — an
   * unwitnessed chain is unverified, never "verified by default". Full
   * verification requires chain-consistency AND allMatch.
   */
  allMatch: boolean;
  /** One verdict per anchor, sorted by chainSeq ascending. */
  results: AnchorMatchResult[];
  counts: Record<AnchorMatchVerdict, number>;
}

/**
 * Match a set of anchors against chain rows.
 *
 * Per anchor: an invalid signature is 'unverifiable' (the chain is not even
 * consulted — a statement we cannot authenticate proves nothing either way);
 * a missing row at the anchored seq is 'seq_gap'; a differing hash is
 * 'hash_mismatch'; equality is 'match'. The dual-era full verifier (backfill
 * leaf) combines this report with chain-consistency into its final verdict.
 */
export function matchAnchorsAgainstChain(
  anchors: readonly SignedAnchor[],
  chain: AnchorChainLookup,
  secret: string,
): AnchorChainMatchReport {
  const lookup = typeof chain === 'function' ? chain : (seq: number) => chain.get(seq);

  const results = anchors
    .map((anchor): AnchorMatchResult => {
      if (!verifyAnchorSignature(anchor, secret)) {
        return {
          chainSeq: anchor.chainSeq,
          verdict: 'unverifiable',
          anchorHead: anchor.head,
          chainHead: null,
        };
      }

      const chainHead = lookup(anchor.chainSeq) ?? null;
      if (chainHead === null) {
        return { chainSeq: anchor.chainSeq, verdict: 'seq_gap', anchorHead: anchor.head, chainHead: null };
      }

      return {
        chainSeq: anchor.chainSeq,
        verdict: chainHead === anchor.head ? 'match' : 'hash_mismatch',
        anchorHead: anchor.head,
        chainHead,
      };
    })
    .sort((a, b) => a.chainSeq - b.chainSeq);

  const counts: Record<AnchorMatchVerdict, number> = {
    match: 0,
    hash_mismatch: 0,
    seq_gap: 0,
    unverifiable: 0,
  };
  for (const result of results) {
    counts[result.verdict]++;
  }

  return {
    allMatch: results.length > 0 && counts.match === results.length,
    results,
    counts,
  };
}
