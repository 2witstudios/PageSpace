import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../storage-repository', () => ({
  storageRepository: {
    findUserForStorage: vi.fn(),
    findUserDriveIds: vi.fn(),
    findFilesByCreator: vi.fn(),
    findStorageDriftCandidates: vi.fn(),
    userReferencesContentHash: vi.fn(),
    countFiles: vi.fn(),
    updateStorageInTx: vi.fn(),
    insertStorageEvent: vi.fn(),
    runTransaction: vi.fn(),
  },
}));

vi.mock('../pending-uploads', () => ({
  reserveUploadSlot: vi.fn(),
  releasePendingUpload: vi.fn(),
  sweepExpiredPendingUploads: vi.fn(),
}));

const mockGetAdvisoryLockPool = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  getAdvisoryLockPool: () => mockGetAdvisoryLockPool(),
}));

import { computeStorageDrift, reconcileAllStorageUsage, reconcileAllStorageUsageSerialized } from '../storage-limits';
import { storageRepository } from '../storage-repository';

describe('computeStorageDrift', () => {
  it('computeStorageDrift_withMatchingValues_isNotFlagged', () => {
    const result = computeStorageDrift({ materializedBytes: 1000, derivedBytes: 1000 }, 0);
    expect(result.driftBytes).toBe(0);
    expect(result.flagged).toBe(false);
  });

  it('computeStorageDrift_withMaterializedAboveDerived_reportsPositiveDrift', () => {
    const result = computeStorageDrift({ materializedBytes: 1500, derivedBytes: 1000 }, 0);
    expect(result.driftBytes).toBe(500);
    expect(result.flagged).toBe(true);
  });

  it('computeStorageDrift_withMaterializedBelowDerived_reportsNegativeDrift', () => {
    const result = computeStorageDrift({ materializedBytes: 400, derivedBytes: 1000 }, 0);
    expect(result.driftBytes).toBe(-600);
    expect(result.flagged).toBe(true);
  });

  it('computeStorageDrift_withDriftExactlyAtTolerance_isNotFlagged', () => {
    const result = computeStorageDrift({ materializedBytes: 1100, derivedBytes: 1000 }, 100);
    expect(result.driftBytes).toBe(100);
    expect(result.flagged).toBe(false);
  });

  it('computeStorageDrift_withDriftJustOverTolerance_isFlagged', () => {
    const result = computeStorageDrift({ materializedBytes: 1101, derivedBytes: 1000 }, 100);
    expect(result.flagged).toBe(true);
  });

  it('computeStorageDrift_withNegativeTolerance_treatsToleranceAsZero', () => {
    const result = computeStorageDrift({ materializedBytes: 1001, derivedBytes: 1000 }, -50);
    expect(result.flagged).toBe(true);
  });

  it('computeStorageDrift_withFractionalCounter_roundsBeforeComparing', () => {
    // users.storageUsedBytes is a REAL column, so the materialized value can be
    // fractional; drift must still be an integer byte count.
    const result = computeStorageDrift({ materializedBytes: 1000.4, derivedBytes: 1000 }, 0);
    expect(result.driftBytes).toBe(0);
    expect(result.flagged).toBe(false);
  });
});

describe('reconcileAllStorageUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(storageRepository.runTransaction).mockImplementation(async (fn) =>
      fn({} as never),
    );
  });

  it('reconcileAllStorageUsage_withNoDriftCandidates_correctsNothing', async () => {
    vi.mocked(storageRepository.findStorageDriftCandidates).mockResolvedValue([]);

    const result = await reconcileAllStorageUsage();

    expect(result.corrected).toEqual([]);
    expect(storageRepository.updateStorageInTx).not.toHaveBeenCalled();
  });

  it('reconcileAllStorageUsage_passesAPositiveCooldownToExcludeVeryRecentUploads', async () => {
    // #2225 review: without a cooldown, the scan can catch a user between
    // upload/complete's files-row insert and its separate (non-atomic)
    // storageUsedBytes update, treat that transient gap as drift, and
    // double-count the upload once the pending update lands.
    vi.mocked(storageRepository.findStorageDriftCandidates).mockResolvedValue([]);

    await reconcileAllStorageUsage();

    expect(storageRepository.findStorageDriftCandidates).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Number),
    );
    const [, cooldownSeconds] = vi.mocked(storageRepository.findStorageDriftCandidates).mock.calls[0];
    expect(cooldownSeconds).toBeGreaterThan(0);
  });

  it('reconcileAllStorageUsage_withDriftedUsers_appliesTheDriftAsADelta', async () => {
    // #2225 review: correction is a DELTA (-driftBytes) via updateStorageInTx,
    // not an absolute overwrite — so a concurrent charge/credit write landing
    // between the drift scan and this correction isn't silently discarded.
    vi.mocked(storageRepository.findStorageDriftCandidates).mockResolvedValue([
      { userId: 'user-1', materializedBytes: 2000, derivedBytes: 1500 },
      { userId: 'user-2', materializedBytes: 100, derivedBytes: 900 },
    ]);
    vi.mocked(storageRepository.updateStorageInTx)
      .mockResolvedValueOnce({ newUsage: 1500 })
      .mockResolvedValueOnce({ newUsage: 900 });

    const result = await reconcileAllStorageUsage();

    expect(storageRepository.updateStorageInTx).toHaveBeenCalledTimes(2);
    expect(storageRepository.updateStorageInTx).toHaveBeenCalledWith(expect.anything(), 'user-1', -500);
    expect(storageRepository.updateStorageInTx).toHaveBeenCalledWith(expect.anything(), 'user-2', 800);
    expect(result.corrected).toEqual([
      { userId: 'user-1', previousUsage: 2000, actualUsage: 1500, driftBytes: 500 },
      { userId: 'user-2', previousUsage: 100, actualUsage: 900, driftBytes: -800 },
    ]);
  });

  it('reconcileAllStorageUsage_withConcurrentWriteBetweenScanAndCorrection_reportsThePostCorrectionCounter', async () => {
    // Simulates a concurrent upload landing +50 on the counter between the
    // drift scan (materialized=2000) and this correction's write. The delta
    // (-500) still applies on top of whatever the counter is by then (2050),
    // so the reported actualUsage (1550) reflects that, not the stale scan-time
    // derived value (1500) — proof the concurrent write wasn't clobbered.
    vi.mocked(storageRepository.findStorageDriftCandidates).mockResolvedValue([
      { userId: 'user-1', materializedBytes: 2000, derivedBytes: 1500 },
    ]);
    vi.mocked(storageRepository.updateStorageInTx).mockResolvedValueOnce({ newUsage: 1550 });

    const result = await reconcileAllStorageUsage();

    expect(storageRepository.updateStorageInTx).toHaveBeenCalledWith(expect.anything(), 'user-1', -500);
    expect(result.corrected).toEqual([
      { userId: 'user-1', previousUsage: 2000, actualUsage: 1550, driftBytes: 500 },
    ]);
  });

  it('reconcileAllStorageUsage_withDriftedUsers_writesReconcileAuditEvent', async () => {
    vi.mocked(storageRepository.findStorageDriftCandidates).mockResolvedValue([
      { userId: 'user-1', materializedBytes: 2000, derivedBytes: 1500 },
    ]);
    vi.mocked(storageRepository.updateStorageInTx).mockResolvedValueOnce({ newUsage: 1500 });

    await reconcileAllStorageUsage();

    expect(storageRepository.insertStorageEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'user-1',
        eventType: 'reconcile',
        sizeDelta: -500,
        totalSizeAfter: 1500,
      }),
    );
  });

  it('reconcileAllStorageUsage_withCandidateWithinTolerance_skipsIt', async () => {
    // Defense in depth: even if the SQL candidate query over-returns, the pure
    // drift check gates the write.
    vi.mocked(storageRepository.findStorageDriftCandidates).mockResolvedValue([
      { userId: 'user-1', materializedBytes: 1000, derivedBytes: 1000 },
    ]);

    const result = await reconcileAllStorageUsage();

    expect(result.corrected).toEqual([]);
    expect(storageRepository.updateStorageInTx).not.toHaveBeenCalled();
  });

  it('reconcileAllStorageUsage_withOneUserFailing_stillReconcilesTheRest', async () => {
    vi.mocked(storageRepository.findStorageDriftCandidates).mockResolvedValue([
      { userId: 'user-1', materializedBytes: 2000, derivedBytes: 1500 },
      { userId: 'user-2', materializedBytes: 100, derivedBytes: 900 },
    ]);
    vi.mocked(storageRepository.runTransaction)
      .mockRejectedValueOnce(new Error('deadlock'))
      .mockImplementation(async (fn) => fn({} as never));
    vi.mocked(storageRepository.updateStorageInTx).mockResolvedValue({ newUsage: 900 });

    const result = await reconcileAllStorageUsage();

    expect(result.corrected).toEqual([
      { userId: 'user-2', previousUsage: 100, actualUsage: 900, driftBytes: -800 },
    ]);
    expect(result.failed).toEqual(['user-1']);
  });
});

describe('reconcileAllStorageUsageSerialized (#2225 review — overlapping cron ticks must not double-apply)', () => {
  // Simulates real Postgres session-advisory-lock semantics with a single
  // shared in-memory flag: exactly one connection can hold it at a time.
  function makeFakeLockPool() {
    let locked = false;
    const pool = {
      connect: vi.fn(async () => ({
        query: vi.fn(async (text: string) => {
          if (text.includes('pg_try_advisory_lock')) {
            if (locked) return { rows: [{ acquired: false }] };
            locked = true;
            return { rows: [{ acquired: true }] };
          }
          if (text.includes('pg_advisory_unlock')) {
            locked = false;
            return { rows: [] };
          }
          return { rows: [] };
        }),
        release: vi.fn(),
      })),
    };
    return { pool, isLocked: () => locked };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(storageRepository.runTransaction).mockImplementation(async (fn) => fn({} as never));
  });

  it('given the lock is already held elsewhere, no-ops WITHOUT reading any drift candidates', async () => {
    const { pool } = makeFakeLockPool();
    await pool.connect().then((c) => c.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired'));

    const result = await reconcileAllStorageUsageSerialized(pool);

    expect(result).toEqual({ outcome: 'lock_busy' });
    expect(storageRepository.findStorageDriftCandidates).not.toHaveBeenCalled();
  });

  it('given two concurrent invocations racing the same lock, lets only one apply the correction (no double-application)', async () => {
    const { pool, isLocked } = makeFakeLockPool();
    vi.mocked(storageRepository.findStorageDriftCandidates).mockResolvedValue([
      { userId: 'user-1', materializedBytes: 0, derivedBytes: 100 },
    ]);
    vi.mocked(storageRepository.updateStorageInTx).mockResolvedValue({ newUsage: 100 });

    const [first, second] = await Promise.all([
      reconcileAllStorageUsageSerialized(pool),
      reconcileAllStorageUsageSerialized(pool),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(['lock_busy', 'reconciled']);
    // The correction (+100) was applied exactly once — this is the concrete
    // "materialized=0, derived=100" double-application scenario the P1 review
    // flagged: without serialization, both runs would call updateStorageInTx
    // with the same +100 delta, landing the counter at 200 instead of 100.
    expect(storageRepository.updateStorageInTx).toHaveBeenCalledTimes(1);
    expect(storageRepository.updateStorageInTx).toHaveBeenCalledWith(expect.anything(), 'user-1', 100);
    expect(isLocked()).toBe(false);
  });

  it('given no explicit pool override, acquires the lock from the dedicated advisory-lock pool', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ acquired: true }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };
    mockGetAdvisoryLockPool.mockReturnValue(pool);
    vi.mocked(storageRepository.findStorageDriftCandidates).mockResolvedValue([]);

    const result = await reconcileAllStorageUsageSerialized();

    expect(result.outcome).toBe('reconciled');
    expect(mockGetAdvisoryLockPool).toHaveBeenCalledTimes(1);
    expect(pool.connect).toHaveBeenCalledTimes(1);
  });

  it('propagates a lock-connection failure (never silently swallowed as a clean run)', async () => {
    const client = {
      query: vi.fn().mockRejectedValueOnce(new Error('connection reset')),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };

    await expect(reconcileAllStorageUsageSerialized(pool)).rejects.toThrow('connection reset');
    expect(storageRepository.findStorageDriftCandidates).not.toHaveBeenCalled();
  });
});
