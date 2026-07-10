/**
 * Unit tests for the audit chainer worker shell (#890 Phase 2, leaf 2).
 *
 * All chain math is pure and pinned in @pagespace/lib chain-step.test.ts —
 * these tests exercise ONLY the wiring: advisory-lock gating, drain order,
 * the single INSERT+DELETE transaction, post-commit verify-on-append, and
 * the loud failure path. The pure functions run unmocked (determinism lets
 * the test recompute expected payloads).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assignChainBatch,
  GENESIS_PREVIOUS_HASH,
  type ChainableIngestRow,
} from '@pagespace/lib/audit/chain-step';

const { mockQuery, mockRelease, mockNotifyAppendFailure } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockRelease: vi.fn(),
  mockNotifyAppendFailure: vi.fn(),
}));

vi.mock('../../db', () => ({
  getAdminPoolForWorker: vi.fn(() => ({
    connect: vi.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
  })),
}));

vi.mock('@pagespace/lib/audit/security-audit-alerting', () => ({
  notifyChainAppendVerificationFailure: mockNotifyAppendFailure,
}));

import { processAuditChainer } from '../audit-chainer-worker';

const mockPool = {
  connect: vi.fn(async () => ({ query: mockQuery, release: mockRelease })),
};

function makeIngestRows(count: number): ChainableIngestRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `ingest-${i}`,
    eventType: 'auth.login.success' as const,
    userId: `user-${i}`,
    sessionId: null,
    serviceId: 'web',
    resourceType: null,
    resourceId: null,
    ipAddress: `ciphertext-${i}`,
    ipBidx: `bidx-${i}`,
    userAgent: null,
    geoLocation: null,
    details: { attempt: i },
    riskScore: null,
    anomalyFlags: null,
    timestamp: new Date(Date.UTC(2026, 0, 25, 10, 0, i)),
    emissionHash: `${'0'.repeat(60)}${i.toString(16).padStart(4, '0')}`,
  }));
}

const stub = (rows: unknown[] = [], rowCount = rows.length) =>
  mockQuery.mockResolvedValueOnce({ rows, rowCount });

const stubLock = (acquired: boolean) => stub([{ acquired }]);

describe('processAuditChainer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('given no ADMIN_DATABASE_URL and no injected pool, should no-op as disabled (trust plane unconfigured)', async () => {
    vi.stubEnv('ADMIN_DATABASE_URL', '');

    const result = await processAuditChainer();

    expect(result).toEqual({ outcome: 'disabled', drained: 0 });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('given the advisory lock is held elsewhere, should no-op WITHOUT unlocking (never release a lock it does not own)', async () => {
    stubLock(false);

    const result = await processAuditChainer({ pool: mockPool });

    expect(result).toEqual({ outcome: 'lock_busy', drained: 0 });
    // Only the try-lock query ran — no unlock, no reads.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toContain('pg_try_advisory_lock');
    expect(mockQuery.mock.calls[0][1]).toEqual(['audit-chainer']);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('given an empty ingest queue, should return idle, skip the head read, and release the lock', async () => {
    stubLock(true);
    stub([]); // ingest SELECT — empty
    stub([]); // unlock

    const result = await processAuditChainer({ pool: mockPool });

    expect(result).toEqual({ outcome: 'idle', drained: 0 });
    expect(mockQuery).toHaveBeenCalledTimes(3);
    expect(mockQuery.mock.calls[1][0]).toContain('FROM security_audit_ingest');
    expect(mockQuery.mock.calls[1][0]).toContain('ORDER BY emitted_at, id');
    expect(mockQuery.mock.calls[2][0]).toContain('pg_advisory_unlock');
  });

  it('given ingest rows and an empty chain, should chain from genesis, insert+delete in ONE transaction, and verify green', async () => {
    const rows = makeIngestRows(3);
    const expected = assignChainBatch(rows, { prevHash: GENESIS_PREVIOUS_HASH });

    stubLock(true);
    stub(rows); // ingest SELECT
    stub([]); // head SELECT — empty chain → genesis
    stub(); // BEGIN
    stub([], 3); // INSERT
    stub([], 3); // DELETE
    stub(); // COMMIT
    stub(
      expected.chainedRowPayloads.map((p) => ({
        id: p.id,
        emissionHash: p.emissionHash,
        previousHash: p.previousHash,
        eventHash: p.eventHash,
      })),
    ); // verify re-read
    stub([]); // unlock

    const result = await processAuditChainer({ pool: mockPool });

    expect(result.outcome).toBe('chained');
    expect(result.drained).toBe(3);
    expect(result.verification).toEqual({ valid: true, verified: 3 });

    const calls = mockQuery.mock.calls.map((c) => String(c[0]));
    expect(calls[3]).toBe('BEGIN');
    expect(calls[4]).toContain('INSERT INTO security_audit_log');
    expect(calls[5]).toContain('DELETE FROM security_audit_ingest');
    expect(calls[6]).toBe('COMMIT');
    // The INSERT carries the pure-core chain values in row order.
    const insertValues = mockQuery.mock.calls[4][1] as unknown[];
    expect(insertValues).toContain(expected.chainedRowPayloads[0].eventHash);
    expect(insertValues).toContain(GENESIS_PREVIOUS_HASH);
    expect(insertValues).toContain(expected.chainedRowPayloads[2].eventHash);
    // The DELETE drains exactly the chained ids.
    expect(mockQuery.mock.calls[5][1]).toEqual([rows.map((r) => r.id)]);
    // Verify re-read walks chain_seq order.
    expect(calls[7]).toContain('ORDER BY chain_seq');
    expect(mockNotifyAppendFailure).not.toHaveBeenCalled();
  });

  it('given an existing chain head, should link the first payload to it (not genesis)', async () => {
    const rows = makeIngestRows(2);
    const priorHead = 'existing-head-hash';
    const expected = assignChainBatch(rows, { prevHash: priorHead });

    stubLock(true);
    stub(rows);
    stub([{ event_hash: priorHead }]); // head SELECT
    stub(); // BEGIN
    stub([], 2); // INSERT
    stub([], 2); // DELETE
    stub(); // COMMIT
    stub(
      expected.chainedRowPayloads.map((p) => ({
        id: p.id,
        emissionHash: p.emissionHash,
        previousHash: p.previousHash,
        eventHash: p.eventHash,
      })),
    );
    stub([]); // unlock

    const result = await processAuditChainer({ pool: mockPool });

    expect(result.verification).toEqual({ valid: true, verified: 2 });
    const headSql = String(mockQuery.mock.calls[2][0]);
    expect(headSql).toContain('FROM security_audit_log');
    expect(headSql).toContain('ORDER BY chain_seq DESC');
    const insertValues = mockQuery.mock.calls[3 + 1][1] as unknown[];
    expect(insertValues).toContain(priorHead);
  });

  it('given a batchSize override, should pass it to the drain LIMIT', async () => {
    stubLock(true);
    stub([]); // ingest — empty
    stub([]); // unlock

    await processAuditChainer({ pool: mockPool, batchSize: 42 });

    expect(mockQuery.mock.calls[1][1]).toEqual([42]);
  });

  it('given the transaction fails, should ROLLBACK, rethrow, and still unlock + release', async () => {
    const rows = makeIngestRows(1);
    stubLock(true);
    stub(rows);
    stub([]); // head
    stub(); // BEGIN
    mockQuery.mockRejectedValueOnce(new Error('insert exploded')); // INSERT
    stub(); // ROLLBACK
    stub([]); // unlock

    await expect(processAuditChainer({ pool: mockPool })).rejects.toThrow('insert exploded');

    const calls = mockQuery.mock.calls.map((c) => String(c[0]));
    expect(calls).toContain('ROLLBACK');
    expect(calls[calls.length - 1]).toContain('pg_advisory_unlock');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('given verify-on-append detects a break, should alert loudly and report the failed verification', async () => {
    const rows = makeIngestRows(2);
    const expected = assignChainBatch(rows, { prevHash: GENESIS_PREVIOUS_HASH });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    stubLock(true);
    stub(rows);
    stub([]); // head — genesis
    stub(); // BEGIN
    stub([], 2); // INSERT
    stub([], 2); // DELETE
    stub(); // COMMIT
    // Re-read returns a TAMPERED second row.
    stub([
      {
        id: expected.chainedRowPayloads[0].id,
        emissionHash: expected.chainedRowPayloads[0].emissionHash,
        previousHash: expected.chainedRowPayloads[0].previousHash,
        eventHash: expected.chainedRowPayloads[0].eventHash,
      },
      {
        id: expected.chainedRowPayloads[1].id,
        emissionHash: expected.chainedRowPayloads[1].emissionHash,
        previousHash: expected.chainedRowPayloads[1].previousHash,
        eventHash: 'tampered-hash',
      },
    ]);
    stub([]); // unlock

    const result = await processAuditChainer({ pool: mockPool });

    expect(result.outcome).toBe('chained');
    expect(result.verification?.valid).toBe(false);
    expect(mockNotifyAppendFailure).toHaveBeenCalledTimes(1);
    expect(mockNotifyAppendFailure.mock.calls[0][0]).toMatchObject({
      entryId: expected.chainedRowPayloads[1].id,
      breakAtIndex: 1,
      breakReason: 'hash_mismatch',
      segmentTotalRows: 2,
      priorHead: GENESIS_PREVIOUS_HASH,
    });
    expect(consoleError).toHaveBeenCalled();
    expect(String(consoleError.mock.calls[0][0])).toContain('VERIFY-ON-APPEND');

    consoleError.mockRestore();
  });

  it('given a broken alert surface, should never mask the detection (alert error swallowed)', async () => {
    const rows = makeIngestRows(1);
    const expected = assignChainBatch(rows, { prevHash: GENESIS_PREVIOUS_HASH });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockNotifyAppendFailure.mockRejectedValueOnce(new Error('alert transport down'));

    stubLock(true);
    stub(rows);
    stub([]);
    stub(); // BEGIN
    stub([], 1); // INSERT
    stub([], 1); // DELETE
    stub(); // COMMIT
    stub([
      {
        id: expected.chainedRowPayloads[0].id,
        emissionHash: null, // forces missing_emission_hash
        previousHash: expected.chainedRowPayloads[0].previousHash,
        eventHash: expected.chainedRowPayloads[0].eventHash,
      },
    ]);
    stub([]); // unlock

    const result = await processAuditChainer({ pool: mockPool });

    expect(result.verification?.valid).toBe(false);
    consoleError.mockRestore();
  });
});
