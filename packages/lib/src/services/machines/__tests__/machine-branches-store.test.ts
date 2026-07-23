import { describe, it, expect } from 'vitest';
import { revivedBranchColumns } from '../machine-branches-store';

/**
 * Machines-feature audit, 2026-07-23. The F11 accounting fix landed on the
 * project tier only; the branch tier has the same lifecycle and the same
 * defect — and it is worse there, because a torn-down branch row is EXCLUDED
 * from the reconcile (`listBranchSprites` filters `spriteTornDownAt IS NULL`),
 * so its watermark freezes for the whole teardown and the next reconcile after
 * revival bills that entire window at the dead generation's size.
 */
describe('revivedBranchColumns', () => {
  const now = new Date('2026-07-23T12:00:00.000Z');
  const base = { sandboxId: 'sbx-new', spriteInstanceId: 'inst-new', now };

  it('given a revived branch, should restart the storage accounting period', () => {
    const columns = revivedBranchColumns(base);
    expect({
      storageLastBilledAt: columns.storageLastBilledAt,
      storageMeasuredBytes: columns.storageMeasuredBytes,
      storageMeasuredAt: columns.storageMeasuredAt,
    }).toEqual({
      // Without this the teardown window itself gets billed on revival.
      storageLastBilledAt: now,
      storageMeasuredBytes: null,
      storageMeasuredAt: null,
    });
  });

  it('given a revived branch, should record the replacement Sprite identity', () => {
    const columns = revivedBranchColumns(base);
    expect({ sandboxId: columns.sandboxId, spriteInstanceId: columns.spriteInstanceId }).toEqual({
      sandboxId: 'sbx-new',
      spriteInstanceId: 'inst-new',
    });
  });

  it('given a revived branch, should void BOTH teardown marks', () => {
    const columns = revivedBranchColumns(base);
    expect({
      spriteTornDownAt: columns.spriteTornDownAt,
      teardownRequestedAt: columns.teardownRequestedAt,
    }).toEqual({ spriteTornDownAt: null, teardownRequestedAt: null });
  });

  it('given a driver that could not report an instance id, should persist null rather than omit it', () => {
    expect(revivedBranchColumns({ ...base, spriteInstanceId: null }).spriteInstanceId).toBeNull();
  });

  it('given a revival, should stamp updatedAt from the injected clock', () => {
    expect(revivedBranchColumns(base).updatedAt).toEqual(now);
  });
});
