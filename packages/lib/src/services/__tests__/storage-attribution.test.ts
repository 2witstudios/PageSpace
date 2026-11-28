import { describe, it, expect } from 'vitest';
import {
  storagePayerForFile,
  computeStorageCreditOnUnlink,
  computeMoveReattribution,
  computeOwnerTransferReattribution,
  buildOrgStorageQuota,
  decideStorageBytes,
  decideFileCount,
  STORAGE_TIERS,
} from '../storage-limits';

/**
 * Storage attribution (Spec WAL-9, O-9; D-OW-9): the payer seam "org if drives.orgId, else owner".
 * Bytes in an org drive attribute to the drive and bill the org; bytes in a personal drive bill
 * the DRIVE'S OWNER, whoever uploaded them; a drive-less attachment (a DM) bills its uploader.
 * Moving a drive in or out of an org, or handing a personal drive to a new owner, re-attributes
 * its bytes. These are the pure rules; the IO edges and the move transaction are proven against
 * real Postgres in storage-attribution.integration.test.ts.
 */

const MARCUS = 'user-marcus';
const LENA = 'user-lena';
const NORTHWIND = 'org-northwind';
const personalDrive = (ownerId: string) => ({ ownerId, orgId: null });
const orgDrive = { ownerId: MARCUS, orgId: NORTHWIND };

describe('storagePayerForFile', () => {
  it('WAL-9 (partial) a file in an org drive bills the org, not the uploader or the lead', () => {
    expect(storagePayerForFile({ createdBy: LENA, drive: orgDrive })).toEqual({ kind: 'org', orgId: NORTHWIND });
    expect(storagePayerForFile({ createdBy: null, drive: orgDrive })).toEqual({ kind: 'org', orgId: NORTHWIND });
  });

  it('WAL-9 (partial) a file in a personal drive bills the drive OWNER, not the member who uploaded it', () => {
    expect(storagePayerForFile({ createdBy: LENA, drive: personalDrive(MARCUS) })).toEqual({ kind: 'user', userId: MARCUS });
    expect(storagePayerForFile({ createdBy: null, drive: personalDrive(MARCUS) })).toEqual({ kind: 'user', userId: MARCUS });
  });

  it('WAL-9 (partial) a drive-less attachment bills its uploader, and nobody once they are gone', () => {
    expect(storagePayerForFile({ createdBy: LENA, drive: null })).toEqual({ kind: 'user', userId: LENA });
    expect(storagePayerForFile({ createdBy: null, drive: null })).toBeNull();
  });
});

describe('computeStorageCreditOnUnlink', () => {
  const reaped = { createdBy: LENA, sizeBytes: 500, deletedByThisCall: true, hadPhysicalBlob: true };

  it('WAL-9 (partial) reaping a personal drive\'s file credits the drive owner exactly once — who was charged for it', () => {
    expect(computeStorageCreditOnUnlink({ ...reaped, drive: personalDrive(MARCUS) })).toEqual({ userId: MARCUS, deltaBytes: -500 });
  });

  it('WAL-9 (partial) reaping a drive-less attachment credits its uploader', () => {
    expect(computeStorageCreditOnUnlink({ ...reaped, drive: null })).toEqual({ userId: LENA, deltaBytes: -500 });
  });

  it('WAL-9 (partial) reaping an org drive file credits no personal quota: no person was charged', () => {
    expect(computeStorageCreditOnUnlink({ ...reaped, drive: orgDrive })).toBeNull();
  });
});

describe('computeMoveReattribution', () => {
  const driveFiles = [
    { createdBy: MARCUS, sizeBytes: 1000 },
    { createdBy: LENA, sizeBytes: '250' },
    { createdBy: null, sizeBytes: 24 },
  ];

  it('WAL-9 (partial) moving a personal drive in takes ALL its bytes off its owner\'s quota — every uploader\'s, the gone ones\' too', () => {
    expect(computeMoveReattribution({ ownerId: MARCUS, files: driveFiles, direction: 'into-org' })).toEqual([{ userId: MARCUS, deltaBytes: -1274 }]);
  });

  it('WAL-9 (partial) moving a drive out puts all its bytes on its owner\'s quota, and a move in then out nets zero', () => {
    expect(computeMoveReattribution({ ownerId: MARCUS, files: driveFiles, direction: 'out-of-org' })).toEqual([{ userId: MARCUS, deltaBytes: 1274 }]);
  });

  it('a drive with no stored bytes re-attributes nothing', () => {
    expect(computeMoveReattribution({ ownerId: MARCUS, files: [{ createdBy: LENA, sizeBytes: 0 }], direction: 'into-org' })).toEqual([]);
  });
});

describe('computeOwnerTransferReattribution', () => {
  it('WAL-9 (partial) handing a personal drive to a new owner moves all its bytes from the old owner\'s quota to the new owner\'s, in user-id order', () => {
    expect(computeOwnerTransferReattribution({ fromUserId: MARCUS, toUserId: LENA, files: [{ createdBy: MARCUS, sizeBytes: 70 }, { createdBy: null, sizeBytes: '30' }] }))
      .toEqual([{ userId: LENA, deltaBytes: 100 }, { userId: MARCUS, deltaBytes: -100 }]);
  });

  it('no bytes, or no change of owner, moves nothing', () => {
    expect(computeOwnerTransferReattribution({ fromUserId: MARCUS, toUserId: LENA, files: [] })).toEqual([]);
    expect(computeOwnerTransferReattribution({ fromUserId: MARCUS, toUserId: MARCUS, files: [{ createdBy: MARCUS, sizeBytes: 5 }] })).toEqual([]);
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
