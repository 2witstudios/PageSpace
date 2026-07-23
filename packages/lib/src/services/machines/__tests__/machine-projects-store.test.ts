import { describe, it, expect } from 'vitest';
import { promotedProjectColumns } from '../machine-projects-store';

/**
 * Issue #2204 follow-up, F11. The promotion CAS retained the creation-time
 * storage watermark, so a project promoted long after its row was created had
 * its first measured clone bytes billed across a period when no project Sprite
 * existed — and a re-provision after teardown inherited the previous
 * generation's measurement across the downtime.
 */
describe('promotedProjectColumns', () => {
  const now = new Date('2026-07-22T12:00:00.000Z');
  const base = { sessionKey: 'key-1', sandboxId: 'sbx-1', spriteInstanceId: 'inst-1', now };

  it('given a promotion, should restart the storage accounting period at this Sprite\'s birth', () => {
    const columns = promotedProjectColumns(base);
    expect({
      storageLastBilledAt: columns.storageLastBilledAt,
      storageMeasuredBytes: columns.storageMeasuredBytes,
      storageMeasuredAt: columns.storageMeasuredAt,
    }).toEqual({
      storageLastBilledAt: now,
      // The previous generation's measurement described a filesystem that no
      // longer exists — inheriting it bills its bytes across the downtime.
      storageMeasuredBytes: null,
      storageMeasuredAt: null,
    });
  });

  it('given a promotion, should record the Sprite identity', () => {
    const columns = promotedProjectColumns(base);
    expect({
      sessionKey: columns.sessionKey,
      sandboxId: columns.sandboxId,
      spriteInstanceId: columns.spriteInstanceId,
    }).toEqual({ sessionKey: 'key-1', sandboxId: 'sbx-1', spriteInstanceId: 'inst-1' });
  });

  it('given a promotion, should void BOTH teardown marks — this row points at a live Sprite', () => {
    const columns = promotedProjectColumns(base);
    expect({
      spriteTornDownAt: columns.spriteTornDownAt,
      teardownRequestedAt: columns.teardownRequestedAt,
    }).toEqual({ spriteTornDownAt: null, teardownRequestedAt: null });
  });

  it('given a driver that could not report an instance id, should persist null rather than omit it', () => {
    expect(promotedProjectColumns({ ...base, spriteInstanceId: null }).spriteInstanceId).toBeNull();
  });

  it('given a promotion, should stamp updatedAt from the injected clock', () => {
    expect(promotedProjectColumns(base).updatedAt).toEqual(now);
  });
});
