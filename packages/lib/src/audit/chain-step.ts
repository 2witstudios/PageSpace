/**
 * Chain step — the pure core of the single-writer audit chainer
 * (#890 Phase 2, leaf 2).
 *
 * The lock-free write path splits hashing in two:
 *   - emission: `computeEmissionHash` (emission-hash.ts) — a pure content
 *     fingerprint computed in-process by the emitter, no head read, no lock.
 *   - chaining (THIS module): `chainHash = H(emissionHash, prevHash)` —
 *     sha256 over stableStringify of exactly those two fields, assigned by
 *     the single chainer worker, so serialization is by construction.
 *
 * 'genesis' sentinel: the same sentinel the legacy advisory-lock chain uses
 * for a first row with no predecessor. After cutover the first chained row
 * anchors to the LEGACY chain head instead — the backfill leaf owns supplying
 * that anchor; these functions just take prevHash as an input.
 *
 * Everything here is pure — no I/O, no Date.now, no db. The worker shell
 * (apps/processor/src/workers/audit-chainer-worker.ts) does the reads/writes.
 * Semantics are pinned by golden vectors in __tests__/chain-step.test.ts.
 */

import { createHash } from 'crypto';
import { stableStringify } from '../utils/stable-stringify';
import type { SecurityEventType } from '@pagespace/db/schema/security-audit';

/**
 * previousHash sentinel for a chain with no predecessor row. Matches the
 * legacy advisory-lock repository's sentinel so pre- and post-cutover chains
 * share one grammar.
 */
export const GENESIS_PREVIOUS_HASH = 'genesis';

/**
 * Compute the SHA-256 chain hash linking one emission to the chain head.
 *
 * @param emissionHash - The row's pure content fingerprint (emission-hash.ts)
 * @param previousChainHash - event_hash of the predecessor row, the legacy
 *   head at cutover, or GENESIS_PREVIOUS_HASH for an empty chain
 * @returns Hexadecimal SHA-256 hash string
 */
export function computeChainHash(emissionHash: string, previousChainHash: string): string {
  const payload = {
    emissionHash,
    previousHash: previousChainHash,
  };

  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

/**
 * An ingest-queue row ready for chaining. Structurally matches
 * SelectSecurityAuditIngest (minus emittedAt, which is drain ordering, not
 * chained content) so the worker can pass drained rows straight through.
 */
export interface ChainableIngestRow {
  id: string;
  eventType: SecurityEventType;
  userId: string | null;
  sessionId: string | null;
  serviceId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  ipAddress: string | null;
  ipBidx: string | null;
  userAgent: string | null;
  geoLocation: string | null;
  details: Record<string, unknown> | null;
  riskScore: number | null;
  anomalyFlags: string[] | null;
  timestamp: Date;
  emissionHash: string;
}

/** The chain head: event_hash of the highest chain_seq row (or a sentinel/anchor). */
export interface ChainHead {
  prevHash: string;
}

/**
 * A fully-chained row ready to INSERT into security_audit_log. chain_seq is
 * deliberately absent — it is assigned by the table's sequence at insert,
 * in payload order, under the chainer's single-writer lock.
 */
export interface ChainedRowPayload extends ChainableIngestRow {
  previousHash: string;
  eventHash: string;
}

export interface ChainBatchAssignment {
  chainedRowPayloads: ChainedRowPayload[];
  newHead: ChainHead;
}

/**
 * Assign chain linkage to an ordered batch of drained ingest rows.
 *
 * Pure fold: row N's previousHash is row N-1's eventHash (the given head for
 * row 0), eventHash = computeChainHash(emissionHash, previousHash). Batches
 * compose: feeding one batch's newHead into the next yields the identical
 * chain as assigning both in a single batch.
 */
export function assignChainBatch(
  ingestRows: readonly ChainableIngestRow[],
  head: ChainHead,
): ChainBatchAssignment {
  let prevHash = head.prevHash;

  const chainedRowPayloads = ingestRows.map((row) => {
    const eventHash = computeChainHash(row.emissionHash, prevHash);
    const payload: ChainedRowPayload = { ...row, previousHash: prevHash, eventHash };
    prevHash = eventHash;
    return payload;
  });

  return { chainedRowPayloads, newHead: { prevHash } };
}

/**
 * The chained-row subset verification needs. emissionHash is nullable here
 * because the STORED column is nullable (NULL marks a legacy-era/backfilled
 * row) — but rows the chainer just appended must always carry it.
 */
export interface AppendedChainRow {
  id: string;
  emissionHash: string | null;
  previousHash: string;
  eventHash: string;
}

export type SegmentVerificationResult =
  | { valid: true; verified: number }
  | {
      valid: false;
      verified: number;
      breakAtIndex: number;
      entryId: string;
      reason: 'missing_emission_hash' | 'linkage_break' | 'hash_mismatch';
      expectedHash: string | null;
      actualHash: string | null;
    };

/**
 * Re-verify a just-appended segment against the head it was chained from:
 * recompute every chainHash from the STORED emission_hash and check linkage.
 *
 * This is verify-on-append — continuous verification at write time instead of
 * daily-cron-only. Scope boundary: a fully self-consistent forged segment
 * passes linkage by construction; catching that requires the externally
 * anchored head (leaf 3), not this function.
 *
 * Rows must be given in chain_seq order. Verifying rows written before the
 * emission-hash era (NULL emission_hash) is the dual-era full verifier's job
 * (backfill leaf), not this function's — a NULL here is a hard failure.
 */
export function verifyAppendedSegment(
  chainedRows: readonly AppendedChainRow[],
  priorHead: ChainHead,
): SegmentVerificationResult {
  let prevHash = priorHead.prevHash;

  for (let i = 0; i < chainedRows.length; i++) {
    const row = chainedRows[i];

    if (row.emissionHash === null) {
      return {
        valid: false,
        verified: i,
        breakAtIndex: i,
        entryId: row.id,
        reason: 'missing_emission_hash',
        expectedHash: null,
        actualHash: null,
      };
    }

    if (row.previousHash !== prevHash) {
      return {
        valid: false,
        verified: i,
        breakAtIndex: i,
        entryId: row.id,
        reason: 'linkage_break',
        expectedHash: prevHash,
        actualHash: row.previousHash,
      };
    }

    const recomputed = computeChainHash(row.emissionHash, prevHash);
    if (recomputed !== row.eventHash) {
      return {
        valid: false,
        verified: i,
        breakAtIndex: i,
        entryId: row.id,
        reason: 'hash_mismatch',
        expectedHash: recomputed,
        actualHash: row.eventHash,
      };
    }

    prevHash = row.eventHash;
  }

  return { valid: true, verified: chainedRows.length };
}
