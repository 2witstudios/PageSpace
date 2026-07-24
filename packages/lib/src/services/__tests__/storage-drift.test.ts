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
    setUserStorageInTx: vi.fn(),
    runTransaction: vi.fn(),
  },
}));

vi.mock('../pending-uploads', () => ({
  countLiveUploadsForUser: vi.fn(),
  registerPendingUpload: vi.fn(),
  releasePendingUpload: vi.fn(),
  sweepExpiredPendingUploads: vi.fn(),
}));

import { computeStorageDrift, reconcileAllStorageUsage } from '../storage-limits';
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
    expect(storageRepository.setUserStorageInTx).not.toHaveBeenCalled();
  });

  it('reconcileAllStorageUsage_withDriftedUsers_resetsCounterToDerivedSum', async () => {
    vi.mocked(storageRepository.findStorageDriftCandidates).mockResolvedValue([
      { userId: 'user-1', materializedBytes: 2000, derivedBytes: 1500 },
      { userId: 'user-2', materializedBytes: 100, derivedBytes: 900 },
    ]);

    const result = await reconcileAllStorageUsage();

    expect(storageRepository.setUserStorageInTx).toHaveBeenCalledTimes(2);
    expect(storageRepository.setUserStorageInTx).toHaveBeenCalledWith(expect.anything(), 'user-1', 1500);
    expect(storageRepository.setUserStorageInTx).toHaveBeenCalledWith(expect.anything(), 'user-2', 900);
    expect(result.corrected).toEqual([
      { userId: 'user-1', previousUsage: 2000, actualUsage: 1500, driftBytes: 500 },
      { userId: 'user-2', previousUsage: 100, actualUsage: 900, driftBytes: -800 },
    ]);
  });

  it('reconcileAllStorageUsage_withDriftedUsers_writesReconcileAuditEvent', async () => {
    vi.mocked(storageRepository.findStorageDriftCandidates).mockResolvedValue([
      { userId: 'user-1', materializedBytes: 2000, derivedBytes: 1500 },
    ]);

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
    expect(storageRepository.setUserStorageInTx).not.toHaveBeenCalled();
  });

  it('reconcileAllStorageUsage_withOneUserFailing_stillReconcilesTheRest', async () => {
    vi.mocked(storageRepository.findStorageDriftCandidates).mockResolvedValue([
      { userId: 'user-1', materializedBytes: 2000, derivedBytes: 1500 },
      { userId: 'user-2', materializedBytes: 100, derivedBytes: 900 },
    ]);
    vi.mocked(storageRepository.runTransaction)
      .mockRejectedValueOnce(new Error('deadlock'))
      .mockImplementation(async (fn) => fn({} as never));

    const result = await reconcileAllStorageUsage();

    expect(result.corrected).toEqual([
      { userId: 'user-2', previousUsage: 100, actualUsage: 900, driftBytes: -800 },
    ]);
    expect(result.failed).toEqual(['user-1']);
  });
});
