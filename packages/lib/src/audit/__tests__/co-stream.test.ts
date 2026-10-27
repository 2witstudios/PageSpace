/**
 * Pure-core suite for the witness co-stream (#890 Phase 2, leaf 4).
 *
 * The co-stream is the second independent witness: at emission time each
 * event's emission hash also goes to stdout → the log collector —
 * infrastructure the database credentials cannot touch. Reconciling
 * co-stream records against the store detects tampering (hash divergence)
 * AND suppression (an attacker deleting ingest rows before chaining leaves
 * a co-stream record they cannot recall). Anchors witness the HEAD; the
 * co-stream witnesses EVERY EVENT.
 *
 * Golden vectors pin the record shape; property tests pin
 * order-independence, window-boundary handling, and empty-set semantics
 * (empty ≠ verified — same precedent as matchAnchorsAgainstChain).
 */
import { describe, it, expect } from 'vitest';

import {
  CO_STREAM_LOG_MESSAGE,
  buildCoStreamRecord,
  reconcileCoStream,
  type CoStreamRecord,
  type CoStreamRecordInput,
  type CoStreamStoreRow,
  type ChainedHeadRef,
  type ReconciliationWindow,
} from '../co-stream';

const WINDOW: ReconciliationWindow = {
  start: new Date('2026-02-01T00:00:00.000Z'),
  end: new Date('2026-02-01T01:00:00.000Z'),
};

function record(overrides: Partial<CoStreamRecord> = {}): CoStreamRecord {
  return {
    eventId: 'evt-1',
    emissionHash: 'hash-1',
    eventType: 'auth.login.success',
    emittedAt: '2026-02-01T00:10:00.000Z',
    ...overrides,
  };
}

function storeRow(overrides: Partial<CoStreamStoreRow> = {}): CoStreamStoreRow {
  return {
    id: 'evt-1',
    emissionHash: 'hash-1',
    eventType: 'auth.login.success',
    timestamp: new Date('2026-02-01T00:10:00.000Z'),
    chainSeq: 1,
    eventHash: 'chain-1',
    ...overrides,
  };
}

const HEAD_1: ChainedHeadRef = { chainSeq: 1, eventHash: 'chain-1' };

describe('buildCoStreamRecord', () => {
  it('golden vector: pins the exact record shape and serialization bytes', () => {
    const built = buildCoStreamRecord({
      eventId: 'nz9x2k4m8p1q3r5t7v0w1y2z',
      emissionHash: 'a3f5b8c1d4e7f0a2b5c8d1e4f7a0b3c6d9e2f5a8b1c4d7e0f3a6b9c2d5e8f1a4',
      eventType: 'auth.login.success',
      emittedAt: new Date('2026-02-01T00:10:00.000Z'),
    });

    expect(built).toEqual({
      eventId: 'nz9x2k4m8p1q3r5t7v0w1y2z',
      emissionHash: 'a3f5b8c1d4e7f0a2b5c8d1e4f7a0b3c6d9e2f5a8b1c4d7e0f3a6b9c2d5e8f1a4',
      eventType: 'auth.login.success',
      emittedAt: '2026-02-01T00:10:00.000Z',
    });
    expect(JSON.stringify(built)).toBe(
      '{"eventId":"nz9x2k4m8p1q3r5t7v0w1y2z",'
      + '"emissionHash":"a3f5b8c1d4e7f0a2b5c8d1e4f7a0b3c6d9e2f5a8b1c4d7e0f3a6b9c2d5e8f1a4",'
      + '"eventType":"auth.login.success",'
      + '"emittedAt":"2026-02-01T00:10:00.000Z"}'
    );
  });

  it('PII allowlist: extra fields on the input can NEVER leak into the record (explicit pick, not spread)', () => {
    const hostileInput = {
      eventId: 'evt-1',
      emissionHash: 'hash-1',
      eventType: 'auth.login.success',
      emittedAt: new Date('2026-02-01T00:10:00.000Z'),
      // Everything below must be dropped by construction.
      userId: 'user-1',
      sessionId: 'sess-1',
      ipAddress: '10.0.0.5',
      userAgent: 'UA/1.0',
      geoLocation: 'US-CA',
      details: { secret: 'pii' },
      riskScore: 0.9,
    } as CoStreamRecordInput;

    const built = buildCoStreamRecord(hostileInput);

    expect(Object.keys(built).sort()).toEqual(['emissionHash', 'emittedAt', 'eventId', 'eventType']);
    const serialized = JSON.stringify(built);
    expect(serialized).not.toContain('user-1');
    expect(serialized).not.toContain('10.0.0.5');
    expect(serialized).not.toContain('pii');
  });

  it('exports a stable log-line message constant for collector-side filtering', () => {
    expect(CO_STREAM_LOG_MESSAGE).toBe('security_audit.costream');
  });
});

describe('reconcileCoStream', () => {
  describe('per-event verdicts', () => {
    it('given a record present in both sides with equal hashes, should verdict "verified"', () => {
      const report = reconcileCoStream([record()], [storeRow()], WINDOW, HEAD_1);

      expect(report.results).toEqual([
        { eventId: 'evt-1', verdict: 'verified', coStreamHash: 'hash-1', storeHash: 'hash-1' },
      ]);
      expect(report.counts).toEqual({
        verified: 1,
        missing_from_store: 0,
        missing_from_costream: 0,
        hash_mismatch: 0,
      });
      expect(report.verified).toBe(true);
    });

    it('given a co-stream record with no store row, should verdict "missing_from_store" (suppression signal)', () => {
      const report = reconcileCoStream([record()], [], WINDOW, null);

      expect(report.results).toEqual([
        { eventId: 'evt-1', verdict: 'missing_from_store', coStreamHash: 'hash-1', storeHash: null },
      ]);
      expect(report.counts.missing_from_store).toBe(1);
      expect(report.verified).toBe(false);
    });

    it('given a store row with no co-stream record, should verdict "missing_from_costream" (collector gap)', () => {
      const report = reconcileCoStream([], [storeRow()], WINDOW, HEAD_1);

      expect(report.results).toEqual([
        { eventId: 'evt-1', verdict: 'missing_from_costream', coStreamHash: null, storeHash: 'hash-1' },
      ]);
      expect(report.counts.missing_from_costream).toBe(1);
      expect(report.verified).toBe(false);
    });

    it('given both sides with differing hashes, should verdict "hash_mismatch" (tamper signal)', () => {
      const report = reconcileCoStream(
        [record()],
        [storeRow({ emissionHash: 'hash-REWRITTEN' })],
        WINDOW,
        HEAD_1,
      );

      expect(report.results).toEqual([
        { eventId: 'evt-1', verdict: 'hash_mismatch', coStreamHash: 'hash-1', storeHash: 'hash-REWRITTEN' },
      ]);
      expect(report.verified).toBe(false);
    });

    it('given a store row whose stored emission_hash is NULL, should verdict "hash_mismatch" — a witnessed event whose stored fingerprint is gone cannot be confirmed', () => {
      const report = reconcileCoStream([record()], [storeRow({ emissionHash: null })], WINDOW, HEAD_1);

      expect(report.results[0]!.verdict).toBe('hash_mismatch');
      expect(report.results[0]!.storeHash).toBeNull();
      expect(report.verified).toBe(false);
    });

    it('given duplicate co-stream lines with the SAME hash (at-least-once log delivery), should collapse them to one verdict', () => {
      const report = reconcileCoStream([record(), record()], [storeRow()], WINDOW, HEAD_1);

      expect(report.results).toHaveLength(1);
      expect(report.results[0]!.verdict).toBe('verified');
      expect(report.verified).toBe(true);
    });

    it('given duplicate co-stream lines that DISAGREE on the hash, should verdict "hash_mismatch" — an inconsistent witness proves nothing', () => {
      const report = reconcileCoStream(
        [record(), record({ emissionHash: 'hash-FORGED' })],
        [storeRow()],
        WINDOW,
        HEAD_1,
      );

      expect(report.results).toHaveLength(1);
      expect(report.results[0]!.verdict).toBe('hash_mismatch');
      expect(report.verified).toBe(false);
    });

    it('results are sorted by eventId ascending regardless of input order', () => {
      const report = reconcileCoStream(
        [record({ eventId: 'evt-c' }), record({ eventId: 'evt-a' })],
        [storeRow({ id: 'evt-b', chainSeq: 2, eventHash: 'chain-2' })],
        WINDOW,
        { chainSeq: 2, eventHash: 'chain-2' },
      );

      expect(report.results.map((r) => r.eventId)).toEqual(['evt-a', 'evt-b', 'evt-c']);
    });
  });

  describe('order-independence (property)', () => {
    it('shuffling both inputs yields the identical report', () => {
      const records = [
        record({ eventId: 'evt-1', emissionHash: 'h1' }),
        record({ eventId: 'evt-2', emissionHash: 'h2' }),
        record({ eventId: 'evt-3', emissionHash: 'h3-costream' }),
        record({ eventId: 'evt-5', emissionHash: 'h5' }),
      ];
      const rows = [
        storeRow({ id: 'evt-1', emissionHash: 'h1', chainSeq: 1, eventHash: 'c1' }),
        storeRow({ id: 'evt-2', emissionHash: 'h2', chainSeq: 2, eventHash: 'c2' }),
        storeRow({ id: 'evt-3', emissionHash: 'h3-store', chainSeq: 3, eventHash: 'c3' }),
        storeRow({ id: 'evt-4', emissionHash: 'h4', chainSeq: 4, eventHash: 'c4' }),
      ];
      const head: ChainedHeadRef = { chainSeq: 4, eventHash: 'c4' };

      const baseline = reconcileCoStream(records, rows, WINDOW, head);
      const shuffled = reconcileCoStream(
        [records[3]!, records[1]!, records[2]!, records[0]!],
        [rows[2]!, rows[3]!, rows[0]!, rows[1]!],
        WINDOW,
        head,
      );

      expect(shuffled).toEqual(baseline);
      expect(baseline.counts).toEqual({
        verified: 2,
        missing_from_store: 1,
        missing_from_costream: 1,
        hash_mismatch: 1,
      });
    });
  });

  describe('window-boundary handling', () => {
    it('window is [start, end): a record AT start is included, a record AT end is excluded', () => {
      const atStart = record({ eventId: 'evt-start', emittedAt: WINDOW.start.toISOString() });
      const atEnd = record({ eventId: 'evt-end', emittedAt: WINDOW.end.toISOString() });
      const rowAtStart = storeRow({ id: 'evt-start', timestamp: new Date(WINDOW.start) });

      const report = reconcileCoStream([atStart, atEnd], [rowAtStart], WINDOW, HEAD_1);

      expect(report.results.map((r) => r.eventId)).toEqual(['evt-start']);
    });

    it('out-of-window entries on EITHER side produce no verdicts — no false suppression/gap signals from outside the window', () => {
      const before = record({ eventId: 'evt-before', emittedAt: '2026-01-31T23:59:59.999Z' });
      const after = record({ eventId: 'evt-after', emittedAt: '2026-02-01T01:00:00.001Z' });
      const rowBefore = storeRow({ id: 'row-before', timestamp: new Date('2026-01-31T23:00:00.000Z'), chainSeq: 7, eventHash: 'c7' });
      const rowAfter = storeRow({ id: 'row-after', timestamp: new Date('2026-02-01T02:00:00.000Z'), chainSeq: 9, eventHash: 'c9' });

      const report = reconcileCoStream([before, after], [rowBefore, rowAfter], WINDOW, null);

      expect(report.results).toEqual([]);
      expect(report.head.windowStoreHead).toBeNull();
    });

    it('a co-stream record with an unparseable emittedAt is never silently window-included', () => {
      const garbled = record({ eventId: 'evt-garbled', emittedAt: 'not-a-date' });

      const report = reconcileCoStream([garbled, record()], [storeRow()], WINDOW, HEAD_1);

      expect(report.results.map((r) => r.eventId)).toEqual(['evt-1']);
    });
  });

  describe('head-equality check', () => {
    it('given the windowed store head equals the independently-read latest chained head, head.matches is true', () => {
      const rows = [
        storeRow({ id: 'evt-1', chainSeq: 1, eventHash: 'c1' }),
        storeRow({ id: 'evt-2', chainSeq: 2, eventHash: 'c2' }),
      ];
      const report = reconcileCoStream(
        [record({ eventId: 'evt-1' }), record({ eventId: 'evt-2' })],
        rows,
        WINDOW,
        { chainSeq: 2, eventHash: 'c2' },
      );

      expect(report.head).toEqual({
        windowStoreHead: { chainSeq: 2, eventHash: 'c2' },
        latestChainedHead: { chainSeq: 2, eventHash: 'c2' },
        matches: true,
      });
      expect(report.verified).toBe(true);
    });

    it('given the heads disagree (tail rows deleted between reads, or an anchor-supplied head), head.matches is false and the report is unverified even with all events verified', () => {
      const report = reconcileCoStream(
        [record()],
        [storeRow()],
        WINDOW,
        { chainSeq: 5, eventHash: 'chain-5' },
      );

      expect(report.head.matches).toBe(false);
      expect(report.counts.verified).toBe(1);
      expect(report.verified).toBe(false);
    });

    it('given no latest chained head supplied, head.matches is false — an unwitnessed head is never "matched by default"', () => {
      const report = reconcileCoStream([record()], [storeRow()], WINDOW, null);

      expect(report.head).toEqual({
        windowStoreHead: { chainSeq: 1, eventHash: 'chain-1' },
        latestChainedHead: null,
        matches: false,
      });
      expect(report.verified).toBe(false);
    });
  });

  describe('empty-set semantics', () => {
    it('given both sides empty, should report verified=false — empty ≠ verified (leaf-3 precedent)', () => {
      const report = reconcileCoStream([], [], WINDOW, null);

      expect(report.verified).toBe(false);
      expect(report.results).toEqual([]);
      expect(report.counts).toEqual({
        verified: 0,
        missing_from_store: 0,
        missing_from_costream: 0,
        hash_mismatch: 0,
      });
      expect(report.head).toEqual({ windowStoreHead: null, latestChainedHead: null, matches: false });
    });

    it('given both sides empty but a chained head supplied, still verified=false — zero witnessed events verify nothing', () => {
      const report = reconcileCoStream([], [], WINDOW, HEAD_1);

      expect(report.verified).toBe(false);
    });
  });

  describe('purity', () => {
    it('does not mutate its inputs', () => {
      const records = [record({ eventId: 'evt-2' }), record({ eventId: 'evt-1' })];
      const rows = [storeRow({ id: 'evt-2', chainSeq: 2, eventHash: 'c2' }), storeRow()];
      const recordsSnapshot = records.map((r) => ({ ...r }));
      const rowsSnapshot = rows.map((r) => ({ ...r }));

      reconcileCoStream(records, rows, WINDOW, HEAD_1);

      expect(records).toEqual(recordsSnapshot);
      expect(rows).toEqual(rowsSnapshot);
    });
  });
});
