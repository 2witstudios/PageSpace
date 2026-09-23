import { describe, it, expect } from 'vitest';
import {
  storagePayerForFile,
  computeStorageCreditOnUnlink,
  computeMoveReattribution,
  buildOrgStorageQuota,
  decideStorageBytes,
  decideFileCount,
  STORAGE_TIERS,
} from '../storage-limits';

/**
 * Storage attribution (Spec WAL-9, O-9; D-OW-9): bytes in an org drive attribute to the drive
 * and bill the org; bytes anywhere else bill the uploader (files.createdBy). Moving a drive in
 * or out of an org re-attributes its bytes. These are the pure rules; the IO edges and the
 * move transaction are proven against real Postgres in storage-attribution.integration.test.ts.
 */

const MARCUS = 'user-marcus';
const LENA = 'user-lena';
const NORTHWIND = 'org-northwind';

describe('storagePayerForFile', () => {
  it('WAL-9 (partial) a file in an org drive bills the org, not the uploader', () => {
    expect(storagePayerForFile({ createdBy: MARCUS, driveOrgId: NORTHWIND })).toEqual({ kind: 'org', orgId: NORTHWIND });
  });

  it('WAL-9 (partial) an org drive file bills the org even when the uploader is gone', () => {
    expect(storagePayerForFile({ createdBy: null, driveOrgId: NORTHWIND })).toEqual({ kind: 'org', orgId: NORTHWIND });
  });

  it('WAL-9 (partial) a file outside any org bills its uploader', () => {
    expect(storagePayerForFile({ createdBy: MARCUS, driveOrgId: null })).toEqual({ kind: 'user', userId: MARCUS });
  });

  it('WAL-9 (partial) a personal file whose uploader was deleted bills nobody', () => {
    expect(storagePayerForFile({ createdBy: null, driveOrgId: null })).toBeNull();
  });
});

describe('computeStorageCreditOnUnlink', () => {
  const reaped = { createdBy: MARCUS, sizeBytes: 500, deletedByThisCall: true, hadPhysicalBlob: true };

  it('WAL-9 (partial) reaping a personal file credits its uploader exactly once', () => {
    expect(computeStorageCreditOnUnlink({ ...reaped, driveOrgId: null })).toEqual({ userId: MARCUS, deltaBytes: -500 });
  });

  it('WAL-9 (partial) reaping an org drive file credits no personal quota: the uploader was never charged', () => {
    expect(computeStorageCreditOnUnlink({ ...reaped, driveOrgId: NORTHWIND })).toBeNull();
  });
});

describe('computeMoveReattribution', () => {
  const driveFiles = [
    { createdBy: MARCUS, sizeBytes: 1000 },
    { createdBy: LENA, sizeBytes: '250' },
    { createdBy: MARCUS, sizeBytes: 24 },
    { createdBy: null, sizeBytes: 9999 },
  ];

  it('WAL-9 (partial) moving a drive in takes each uploader\'s bytes off their personal quota, exactly', () => {
    expect(computeMoveReattribution({ files: driveFiles, direction: 'into-org' })).toEqual([
      { userId: LENA, deltaBytes: -250 },
      { userId: MARCUS, deltaBytes: -1024 },
    ]);
  });

  it('WAL-9 (partial) moving a drive out puts each uploader\'s bytes back on their personal quota, exactly', () => {
    expect(computeMoveReattribution({ files: driveFiles, direction: 'out-of-org' })).toEqual([
      { userId: LENA, deltaBytes: 250 },
      { userId: MARCUS, deltaBytes: 1024 },
    ]);
  });

  it('WAL-9 (partial) a move in then out is a net zero for every uploader: nothing double-counted or orphaned', () => {
    const net = new Map<string, number>();
    for (const direction of ['into-org', 'out-of-org'] as const) {
      for (const { userId, deltaBytes } of computeMoveReattribution({ files: driveFiles, direction })) {
        net.set(userId, (net.get(userId) ?? 0) + deltaBytes);
      }
    }
    expect([...net.values()].every((v) => v === 0)).toBe(true);
    expect([...net.keys()].sort()).toEqual([LENA, MARCUS]);
  });

  it('bytes whose uploader was deleted were never charged to anyone, so nobody is credited or charged', () => {
    expect(computeMoveReattribution({ files: [{ createdBy: null, sizeBytes: 10 }], direction: 'out-of-org' })).toEqual([]);
  });

  it('a drive with no stored bytes re-attributes nothing', () => {
    expect(computeMoveReattribution({ files: [{ createdBy: MARCUS, sizeBytes: 0 }], direction: 'into-org' })).toEqual([]);
  });

  it('orders users by id so every move locks user rows in one order', () => {
    const files = [{ createdBy: 'z', sizeBytes: 1 }, { createdBy: 'a', sizeBytes: 1 }, { createdBy: 'm', sizeBytes: 1 }];
    expect(computeMoveReattribution({ files, direction: 'into-org' }).map((d) => d.userId)).toEqual(['a', 'm', 'z']);
  });
});

describe('org storage quota', () => {
  const business = STORAGE_TIERS.business;

  it('WAL-9 (partial) an org\'s quota is the Business tier (every org is on Business) over its derived usage', () => {
    const quota = buildOrgStorageQuota({ orgId: NORTHWIND, usedBytes: 100 });
    expect(quota).toMatchObject({
      orgId: NORTHWIND,
      tier: 'business',
      quotaBytes: business.quotaBytes,
      usedBytes: 100,
      availableBytes: business.quotaBytes - 100,
    });
  });

  it('WAL-9 (partial) an org upload over the org\'s remaining bytes is refused on the org\'s quota', () => {
    const quota = buildOrgStorageQuota({ orgId: NORTHWIND, usedBytes: business.quotaBytes - 10 });
    const verdict = decideStorageBytes({ quota, fileSize: 11 });
    expect(verdict.allowed).toBe(false);
    expect(verdict.quota).toBe(quota);
  });

  it('WAL-9 (partial) an org upload within the org\'s remaining bytes is allowed', () => {
    const quota = buildOrgStorageQuota({ orgId: NORTHWIND, usedBytes: business.quotaBytes - 10 });
    expect(decideStorageBytes({ quota, fileSize: 10 }).allowed).toBe(true);
  });

  it('refuses a file larger than the tier\'s per-file limit', () => {
    const quota = buildOrgStorageQuota({ orgId: NORTHWIND, usedBytes: 0 });
    expect(decideStorageBytes({ quota, fileSize: business.maxFileSize + 1 }).allowed).toBe(false);
  });

  it('refuses once the tier\'s file count is reached, and allows below it', () => {
    const quota = buildOrgStorageQuota({ orgId: NORTHWIND, usedBytes: 0 });
    const limit = business.maxFileCount;
    if (limit > 0) {
      expect(decideFileCount({ quota, fileCount: limit }).allowed).toBe(false);
      expect(decideFileCount({ quota, fileCount: limit - 1 }).allowed).toBe(true);
    } else {
      // 0 means unlimited.
      expect(decideFileCount({ quota, fileCount: Number.MAX_SAFE_INTEGER }).allowed).toBe(true);
    }
  });
});
