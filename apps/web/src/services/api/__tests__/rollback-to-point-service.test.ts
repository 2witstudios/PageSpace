/**
 * executeRollbackToPoint's transaction: the org rows of every drive (and every page's drive) the replayed activities
 * touch are share-locked on the rollback's own tx BEFORE the first activity writes (review #2762 P3-3, re-verify N6).
 * Taken later, a re-entering grant's guests-policy check can deadlock with a concurrent policy change.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ActivityActionPreview } from '@/types/activity-actions';

vi.mock('@pagespace/db/db', () => ({ db: { transaction: vi.fn() } }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));
vi.mock('../rollback-service', () => ({ executeRollback: vi.fn(), previewRollback: vi.fn(), getActivityById: vi.fn() }));
vi.mock('@pagespace/lib/organizations/policy-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/organizations/policy-reader')>()),
  lockOrgsOfDrivesForShare: vi.fn(async () => {}),
}));

import { db } from '@pagespace/db/db';
import { executeRollback } from '../rollback-service';
import { lockOrgsOfDrivesForShare } from '@pagespace/lib/organizations/policy-reader';
import { executeRollbackToPoint, type RollbackToPointPreview } from '../rollback-to-point-service';

const canRun: ActivityActionPreview = {
  action: 'rollback', canExecute: true, reason: undefined, warnings: [], hasConflict: false, conflictFields: [],
  requiresForce: false, isNoOp: false, currentValues: null, targetValues: null, changes: [], affectedResources: [],
};

const activity = (id: string, driveId: string | null, pageId: string | null) => ({
  id, operation: 'update', resourceType: 'page', resourceId: pageId ?? id, resourceTitle: 'Roadmap', pageId, driveId,
  timestamp: new Date('2026-10-01T10:00:00Z'), actorEmail: null, actorDisplayName: null, isAiGenerated: false, preview: canRun,
});

const preview: RollbackToPointPreview = {
  activityId: 'act_1',
  context: 'drive',
  pageId: null,
  driveId: 'drive_product',
  timestamp: new Date('2026-10-01T10:00:00Z'),
  activitiesAffected: [activity('act_2', 'drive_product', 'page_roadmap'), activity('act_1', 'drive_ops', null)],
  warnings: [],
};

describe('executeRollbackToPoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(executeRollback).mockResolvedValue({ action: 'rollback', status: 'success', success: true, message: 'OK', warnings: [], changesApplied: [] });
  });

  it('POL-2 (partial) share-locks the org rows of every touched drive and page on the rollback\'s tx BEFORE any activity is rolled back (review #2762 P3-3, N6)', async () => {
    const tx = { marker: 'rollback-tx' };
    vi.mocked(db.transaction).mockImplementation((async (callback: (t: typeof tx) => Promise<void>) => callback(tx)) as unknown as typeof db.transaction);

    const result = await executeRollbackToPoint('act_1', 'user_dana', 'drive', preview);

    expect(result).toEqual({ success: true, activitiesRolledBack: 2, errors: [] });
    const lock = vi.mocked(lockOrgsOfDrivesForShare);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(lock).toHaveBeenCalledWith(tx, { driveIds: ['drive_product', 'drive_ops'], pageIds: ['page_roadmap', null] });
    expect(vi.mocked(executeRollback).mock.calls.map((c) => [c[0], c[3]?.tx])).toEqual([['act_2', tx], ['act_1', tx]]);
    expect(lock.mock.invocationCallOrder[0]).toBeLessThan(Math.min(...vi.mocked(executeRollback).mock.invocationCallOrder));
  });

  it('POL-2 (partial) a lock that fails aborts the rollback before anything is written', async () => {
    vi.mocked(db.transaction).mockImplementation((async (callback: (t: object) => Promise<void>) => callback({})) as unknown as typeof db.transaction);
    vi.mocked(lockOrgsOfDrivesForShare).mockRejectedValueOnce(new Error('deadlock detected'));

    const result = await executeRollbackToPoint('act_1', 'user_dana', 'drive', preview);

    expect(result).toEqual({ success: false, activitiesRolledBack: 0, errors: ['deadlock detected'] });
    expect(executeRollback).not.toHaveBeenCalled();
  });
});
