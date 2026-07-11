import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReturning = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockWhere = vi.hoisted(() => vi.fn().mockReturnValue({ returning: mockReturning }));
const mockSelectWhere = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockFrom = vi.hoisted(() => vi.fn().mockReturnValue({ where: mockSelectWhere }));
const mockUpdateWhere = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockSet = vi.hoisted(() => vi.fn().mockReturnValue({ where: mockUpdateWhere }));

vi.mock('@pagespace/db/db', () => ({
  db: {
    delete: vi.fn().mockReturnValue({ where: mockWhere }),
    select: vi.fn().mockReturnValue({ from: mockFrom }),
    update: vi.fn().mockReturnValue({ set: mockSet }),
  },
}));
vi.mock('@pagespace/db/schema/monitoring', () => ({
  systemLogs: { id: 'id', userId: 'system_logs.user_id' },
  apiMetrics: { id: 'id', userId: 'api_metrics.user_id' },
  errorLogs: { id: 'error_logs.id', userId: 'error_logs.user_id' },
  userActivities: { id: 'id', userId: 'user_activities.user_id' },
  errorResolutions: {
    errorId: 'error_resolutions.error_id',
    resolvedBy: 'error_resolutions.resolved_by',
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field, value) => ({ type: 'eq', field, value })),
  inArray: vi.fn((field, values) => ({ type: 'inArray', field, values })),
}));
vi.mock('../../observability/clickhouse-client', () => ({
  getClickHouseGdprClient: vi.fn(() => null),
}));
vi.mock('../../observability/analytics-gdpr', () => ({
  deleteChUserAnalytics: vi.fn().mockResolvedValue(undefined),
  collectChUserErrorIds: vi.fn().mockResolvedValue([]),
}));

import { deleteMonitoringDataForUser } from '../monitoring-purge';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import {
  systemLogs,
  apiMetrics,
  errorLogs,
  userActivities,
  errorResolutions,
} from '@pagespace/db/schema/monitoring';
import { getClickHouseGdprClient } from '../../observability/clickhouse-client';
import { deleteChUserAnalytics, collectChUserErrorIds } from '../../observability/analytics-gdpr';

describe('deleteMonitoringDataForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReturning.mockResolvedValue([]);
    mockWhere.mockReturnValue({ returning: mockReturning });
    mockSelectWhere.mockResolvedValue([]);
    mockFrom.mockReturnValue({ where: mockSelectWhere });
    mockUpdateWhere.mockResolvedValue(undefined);
    mockSet.mockReturnValue({ where: mockUpdateWhere });
    vi.mocked(db.delete).mockReturnValue({ where: mockWhere } as never);
    vi.mocked(db.select).mockReturnValue({ from: mockFrom } as never);
    vi.mocked(db.update).mockReturnValue({ set: mockSet } as never);
    vi.mocked(getClickHouseGdprClient).mockReturnValue(null);
    vi.mocked(collectChUserErrorIds).mockResolvedValue([]);
    vi.mocked(deleteChUserAnalytics).mockResolvedValue(undefined);
  });

  it('given a userId, should delete from all four monitoring tables', async () => {
    await deleteMonitoringDataForUser('user-123');

    expect(db.delete).toHaveBeenCalledWith(systemLogs);
    expect(db.delete).toHaveBeenCalledWith(apiMetrics);
    expect(db.delete).toHaveBeenCalledWith(errorLogs);
    expect(db.delete).toHaveBeenCalledWith(userActivities);
  });

  it('given a userId, should filter by the correct userId for each table', async () => {
    await deleteMonitoringDataForUser('user-456');

    expect(eq).toHaveBeenCalledWith(systemLogs.userId, 'user-456');
    expect(eq).toHaveBeenCalledWith(apiMetrics.userId, 'user-456');
    expect(eq).toHaveBeenCalledWith(errorLogs.userId, 'user-456');
    expect(eq).toHaveBeenCalledWith(userActivities.userId, 'user-456');
  });

  it('given successful deletions, should return counts per table', async () => {
    mockReturning
      .mockResolvedValueOnce([{ id: '1' }])
      .mockResolvedValueOnce([{ id: '2' }, { id: '3' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: '4' }]);

    const result = await deleteMonitoringDataForUser('user-123');

    expect(result).toEqual({
      systemLogs: 1,
      apiMetrics: 2,
      errorLogs: 0,
      userActivities: 1,
      errorResolutions: 0,
    });
  });

  it('given a database error, should propagate it', async () => {
    mockReturning.mockRejectedValue(new Error('Connection lost'));

    await expect(deleteMonitoringDataForUser('user-123')).rejects.toThrow('Connection lost');
  });

  it('given no CH config at all (default), should never touch the CH erasure path', async () => {
    await deleteMonitoringDataForUser('user-123');

    expect(deleteChUserAnalytics).not.toHaveBeenCalled();
    expect(collectChUserErrorIds).not.toHaveBeenCalled();
  });

  describe('error_resolutions cleanup (#890 Phase 3 FIX — orphaned resolution notes)', () => {
    it('given the subject has PG error rows, should delete their error_resolutions rows by error id', async () => {
      mockSelectWhere.mockResolvedValueOnce([{ id: 'pg-err-1' }, { id: 'pg-err-2' }]);
      mockReturning.mockResolvedValue([]);

      await deleteMonitoringDataForUser('user-123');

      expect(db.delete).toHaveBeenCalledWith(errorResolutions);
      expect(inArray).toHaveBeenCalledWith(errorResolutions.errorId, ['pg-err-1', 'pg-err-2']);
    });

    it('given the subject has no error rows in either store, should skip the resolutions delete', async () => {
      await deleteMonitoringDataForUser('user-123');

      expect(db.delete).not.toHaveBeenCalledWith(errorResolutions);
    });

    it('should always null resolvedBy where the subject was the RESOLVER (their id must not survive their erasure)', async () => {
      await deleteMonitoringDataForUser('user-123');

      expect(db.update).toHaveBeenCalledWith(errorResolutions);
      expect(mockSet).toHaveBeenCalledWith({ resolvedBy: null });
      expect(eq).toHaveBeenCalledWith(errorResolutions.resolvedBy, 'user-123');
    });

    it('given resolution rows deleted, should report the count', async () => {
      mockSelectWhere.mockResolvedValueOnce([{ id: 'pg-err-1' }]);
      // First returning() call is the resolutions delete in execution order.
      mockReturning.mockResolvedValueOnce([{ errorId: 'pg-err-1' }]);

      const result = await deleteMonitoringDataForUser('user-123');

      expect(result.errorResolutions).toBe(1);
    });
  });

  describe('with CH configured (GDPR reaches BOTH stores — flag-independent)', () => {
    const chClient = { command: vi.fn() };

    beforeEach(() => {
      // getClickHouseGdprClient returns a client whenever CH is configured at
      // all — including the flag-rollback window. The flag logic itself is
      // unit-tested in clickhouse-client/clickhouse-env.
      vi.mocked(getClickHouseGdprClient).mockReturnValue(chClient as never);
    });

    it('given a userId, should erase from CH AND still delete the PG copies', async () => {
      await deleteMonitoringDataForUser('user-789');

      expect(deleteChUserAnalytics).toHaveBeenCalledWith(chClient, 'user-789');
      expect(db.delete).toHaveBeenCalledWith(systemLogs);
      expect(db.delete).toHaveBeenCalledWith(apiMetrics);
      expect(db.delete).toHaveBeenCalledWith(errorLogs);
      expect(db.delete).toHaveBeenCalledWith(userActivities);
    });

    it('should collect CH error ids and clean their resolutions BEFORE the CH delete destroys the join key', async () => {
      vi.mocked(collectChUserErrorIds).mockResolvedValue(['ch-err-1']);
      mockReturning.mockResolvedValue([]);

      await deleteMonitoringDataForUser('user-789');

      expect(inArray).toHaveBeenCalledWith(errorResolutions.errorId, ['ch-err-1']);
      const resolutionsDeleteOrder = vi
        .mocked(db.delete)
        .mock.calls.findIndex(([table]) => table === errorResolutions);
      expect(resolutionsDeleteOrder).toBeGreaterThan(-1);
      const deleteInvocationOrder = vi.mocked(db.delete).mock.invocationCallOrder[resolutionsDeleteOrder];
      const chDeleteOrder = vi.mocked(deleteChUserAnalytics).mock.invocationCallOrder[0];
      expect(deleteInvocationOrder).toBeLessThan(chDeleteOrder);
    });

    it('should merge PG and CH error ids for the resolutions cleanup', async () => {
      mockSelectWhere.mockResolvedValueOnce([{ id: 'pg-err-1' }]);
      vi.mocked(collectChUserErrorIds).mockResolvedValue(['ch-err-1']);

      await deleteMonitoringDataForUser('user-789');

      expect(inArray).toHaveBeenCalledWith(errorResolutions.errorId, ['pg-err-1', 'ch-err-1']);
    });

    it('given a CH erasure failure, should propagate (Art 17 erasure is fail-closed)', async () => {
      vi.mocked(deleteChUserAnalytics).mockRejectedValueOnce(new Error('mutation rejected'));

      await expect(deleteMonitoringDataForUser('user-789')).rejects.toThrow('mutation rejected');
    });
  });

  it('given a misconfigured CH (getClickHouseGdprClient throws), should propagate rather than skip erasure', async () => {
    vi.mocked(getClickHouseGdprClient).mockImplementation(() => {
      throw new Error('ClickHouse misconfigured: GDPR client unavailable');
    });

    await expect(deleteMonitoringDataForUser('user-789')).rejects.toThrow('ClickHouse misconfigured');
    expect(deleteChUserAnalytics).not.toHaveBeenCalled();
    // Nothing was deleted from PG either — the run must be retryable as a whole.
    expect(db.delete).not.toHaveBeenCalled();
  });
});
