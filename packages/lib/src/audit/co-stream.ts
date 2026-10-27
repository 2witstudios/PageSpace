/**
 * Witness co-stream — the pure core (#890 Phase 2, leaf 4).
 *
 * The co-stream is the SECOND independent witness: at emission time each
 * audit event's emission hash also goes to stdout → the log collector —
 * infrastructure the database credentials cannot touch. Anchors (anchor.ts)
 * witness the HEAD; the co-stream witnesses EVERY EVENT. Reconciling
 * co-stream records against the store detects both tampering (hash
 * divergence) and suppression (an attacker deleting ingest rows before
 * chaining leaves a co-stream record they cannot recall).
 *
 * The record is PII-free BY CONSTRUCTION: exactly {eventId, emissionHash,
 * eventType, emittedAt} — no details jsonb, no IPs even encrypted, no
 * user/session ids. buildCoStreamRecord is an explicit field pick (never a
 * spread) so nothing beyond the allowlist can ever reach the log line;
 * __tests__/co-stream.test.ts proves it against a hostile input.
 *
 * This module is pure — no I/O, no Date.now, no db. The emission shell is
 * audit-ingest-writer.ts (one structured-logger line after a successful
 * ingest INSERT); the store-read shell is co-stream-reconciliation.ts.
 * Record-shape bytes are pinned by a golden vector.
 */

import type { SecurityEventType } from '@pagespace/db/schema/security-audit';

/**
 * Log-line message of every co-stream emission — the collector-side filter
 * key (grep/Vector match on this string picks the witness stream out of the
 * security category).
 */
export const CO_STREAM_LOG_MESSAGE = 'security_audit.costream';

/**
 * One witness line: the full allowlist, nothing else. A type alias (not an
 * interface) so it carries an implicit index signature and satisfies the
 * structured logger's LogInput metadata parameter.
 */
export type CoStreamRecord = {
  /** Ingest row id (writer-generated cuid2) — the reconciliation join key. */
  eventId: string;
  /** Pure content fingerprint (emission-hash.ts) — the tamper check. */
  emissionHash: string;
  eventType: SecurityEventType;
  /** Event timestamp (the emission-hash input) as an ISO-8601 string. */
  emittedAt: string;
};

/**
 * Builder input. Extra properties on a wider object are accepted by TS
 * structural typing but can never survive into the record — the builder
 * picks explicitly.
 */
export interface CoStreamRecordInput {
  eventId: string;
  emissionHash: string;
  eventType: SecurityEventType;
  emittedAt: Date;
}

/**
 * Build the witness record via an explicit allowlist pick. Deliberately NOT
 * a spread: a caller passing a whole event row must still yield exactly the
 * four witness fields.
 */
export function buildCoStreamRecord(input: CoStreamRecordInput): CoStreamRecord {
  return {
    eventId: input.eventId,
    emissionHash: input.emissionHash,
    eventType: input.eventType,
    emittedAt: input.emittedAt.toISOString(),
  };
}

/**
 * The chained-store row subset reconciliation needs (admin-plane
 * security_audit_log). emissionHash is nullable because the STORED column
 * is nullable (NULL = legacy-era row) — but every co-stream-era row must
 * carry it, so a witnessed event matching a NULL-hash row is a tamper
 * signal, not a legacy case.
 */
export interface CoStreamStoreRow {
  id: string;
  emissionHash: string | null;
  eventType: SecurityEventType;
  /** Event timestamp — same value the co-stream record's emittedAt carries. */
  timestamp: Date;
  chainSeq: number;
  eventHash: string;
}

/** Half-open reconciliation window: [start, end). */
export interface ReconciliationWindow {
  start: Date;
  end: Date;
}

/** A chained head reference: event_hash at a chain_seq. */
export interface ChainedHeadRef {
  chainSeq: number;
  eventHash: string;
}

export type CoStreamEventVerdict =
  /** Present in both, hashes equal. */
  | 'verified'
  /** Witnessed at emission but absent from the store — suppression signal. */
  | 'missing_from_store'
  /** In the store but never witnessed — collector gap. */
  | 'missing_from_costream'
  /** Present in both but the hashes diverge (or the stored/witnessed hash is unusable) — tamper signal. */
  | 'hash_mismatch';

export interface CoStreamEventResult {
  eventId: string;
  verdict: CoStreamEventVerdict;
  /** Witnessed hash; null when absent from the co-stream or self-contradictory. */
  coStreamHash: string | null;
  /** Stored hash; null when absent from the store or stored as NULL. */
  storeHash: string | null;
}

export interface CoStreamHeadCheck {
  /** Head derived from the store rows given: max chain_seq in the window. */
  windowStoreHead: ChainedHeadRef | null;
  /**
   * Independently-read head the caller supplies — a separate store query
   * (co-stream-reconciliation.ts) or a stronger external witness (anchor).
   */
  latestChainedHead: ChainedHeadRef | null;
  /** True only when BOTH heads exist and agree on seq and hash. */
  matches: boolean;
}

export interface CoStreamReconciliationReport {
  /**
   * True only when ≥1 event reconciled, EVERY verdict is 'verified', and the
   * head check matches. Empty ≠ verified (matchAnchorsAgainstChain precedent).
   */
  verified: boolean;
  /** One result per eventId, sorted ascending — deterministic regardless of input order. */
  results: CoStreamEventResult[];
  counts: Record<CoStreamEventVerdict, number>;
  head: CoStreamHeadCheck;
}

const inWindow = (at: number, window: ReconciliationWindow): boolean =>
  Number.isFinite(at) && at >= window.start.getTime() && at < window.end.getTime();

/**
 * Reconcile witness records against chained store rows over a window.
 *
 * Pure set comparison keyed by eventId — order-independent on both sides.
 * Entries outside [start, end) on EITHER side are ignored, so a window never
 * yields false suppression/gap signals for events beyond its edges.
 * Duplicate co-stream lines (at-least-once log delivery) collapse when they
 * agree; disagreeing duplicates make that event 'hash_mismatch' — an
 * inconsistent witness proves nothing.
 */
export function reconcileCoStream(
  coStreamRecords: readonly CoStreamRecord[],
  storeRows: readonly CoStreamStoreRow[],
  window: ReconciliationWindow,
  latestChainedHead: ChainedHeadRef | null,
): CoStreamReconciliationReport {
  // Witness side: dedupe by eventId; conflicting hashes poison the entry.
  const witnessed = new Map<string, { hash: string; conflicted: boolean }>();
  for (const record of coStreamRecords) {
    if (!inWindow(Date.parse(record.emittedAt), window)) continue;
    const existing = witnessed.get(record.eventId);
    if (!existing) {
      witnessed.set(record.eventId, { hash: record.emissionHash, conflicted: false });
    } else if (existing.hash !== record.emissionHash) {
      existing.conflicted = true;
    }
  }

  const stored = new Map<string, CoStreamStoreRow>();
  for (const row of storeRows) {
    if (!inWindow(row.timestamp.getTime(), window)) continue;
    stored.set(row.id, row);
  }

  const results: CoStreamEventResult[] = [];

  for (const [eventId, witness] of witnessed) {
    const row = stored.get(eventId);
    if (!row) {
      results.push({
        eventId,
        verdict: 'missing_from_store',
        coStreamHash: witness.conflicted ? null : witness.hash,
        storeHash: null,
      });
      continue;
    }
    const matched =
      !witness.conflicted && row.emissionHash !== null && row.emissionHash === witness.hash;
    results.push({
      eventId,
      verdict: matched ? 'verified' : 'hash_mismatch',
      coStreamHash: witness.conflicted ? null : witness.hash,
      storeHash: row.emissionHash,
    });
  }

  for (const [eventId, row] of stored) {
    if (witnessed.has(eventId)) continue;
    results.push({
      eventId,
      verdict: 'missing_from_costream',
      coStreamHash: null,
      storeHash: row.emissionHash,
    });
  }

  results.sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));

  const counts: Record<CoStreamEventVerdict, number> = {
    verified: 0,
    missing_from_store: 0,
    missing_from_costream: 0,
    hash_mismatch: 0,
  };
  for (const result of results) {
    counts[result.verdict]++;
  }

  let windowStoreHead: ChainedHeadRef | null = null;
  for (const row of stored.values()) {
    if (windowStoreHead === null || row.chainSeq > windowStoreHead.chainSeq) {
      windowStoreHead = { chainSeq: row.chainSeq, eventHash: row.eventHash };
    }
  }

  const matches =
    windowStoreHead !== null &&
    latestChainedHead !== null &&
    windowStoreHead.chainSeq === latestChainedHead.chainSeq &&
    windowStoreHead.eventHash === latestChainedHead.eventHash;

  return {
    verified: results.length > 0 && counts.verified === results.length && matches,
    results,
    counts,
    head: { windowStoreHead, latestChainedHead, matches },
  };
}
