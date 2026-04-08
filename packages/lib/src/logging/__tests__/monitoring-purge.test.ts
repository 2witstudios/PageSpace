import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReturning = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockWhere = vi.hoisted(() => vi.fn().mockReturnValue({ returning: mockReturning }));

vi.mock('@pagespace/db', () => ({
  db: {
    delete: vi.fn().mockReturnValue({ where: mockWhere }),
  },
  systemLogs: { id: 'id', userId: 'system_logs.user_id' },
  apiMetrics: { id: 'id', userId: 'api_metrics.user_id' },
  errorLogs: { id: 'id', userId: 'error_logs.user_id' },
  userActivities: { id: 'id', userId: 'user_activities.user_id' },
  eq: vi.fn((field, value) => ({ type: 'eq', field, value })),
}));

import { deleteMonitoringDataForUser } from '../monitoring-purge';
import { db, eq, systemLogs, apiMetrics, errorLogs, userActivities } from '@pagespace/db';

describe('deleteMonitoringDataForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReturning.mockResolvedValue([]);
    mockWhere.mockReturnValue({ returning: mockReturning });
    vi.mocked(db.delete).mockReturnValue({ where: mockWhere } as never);
  });

  it('given a userId, should delete from all four monitoring tables', async () => {
    await deleteMonitoringDataForUser('user-123');

    expect(db.delete).toHaveBeenCalledWith(systemLogs);
    expect(db.delete).toHaveBeenCalledWith(apiMetrics);
    expect(db.delete).toHaveBeenCalledWith(errorLogs);
    expect(db.delete).toHaveBeenCalledWith(userActivities);
    expect(db.delete).toHaveBeenCalledTimes(4);
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
    });
  });

  it('given a database error, should propagate it', async () => {
    mockReturning.mockRejectedValue(new Error('Connection lost'));

    await expect(deleteMonitoringDataForUser('user-123')).rejects.toThrow('Connection lost');
  });
});
