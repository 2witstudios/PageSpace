/**
 * AI Usage Purge Tests
 *
 * Tests for AI usage log lifecycle functions:
 * - Full row purge (TTL-based)
 * - User-scoped deletion (account deletion)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReturning = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockWhere = vi.hoisted(() => vi.fn().mockReturnValue({ returning: mockReturning }));

vi.mock('@pagespace/db/db', () => ({
  db: {
    delete: vi.fn().mockReturnValue({ where: mockWhere }),
  },
}));
vi.mock('@pagespace/db/schema/monitoring', () => ({
  aiUsageLogs: {
    id: 'id',
    timestamp: 'timestamp',
    userId: 'userId',
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  lt: vi.fn((field, value) => ({ type: 'lt', field, value })),
  eq: vi.fn((field, value) => ({ type: 'eq', field, value })),
}));

import {
  purgeAiUsageLogs,
  deleteAiUsageLogsForUser,
} from '../ai-usage-purge';
import { db } from '@pagespace/db/db';

describe('ai-usage-purge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReturning.mockResolvedValue([]);
    mockWhere.mockReturnValue({ returning: mockReturning });
    vi.mocked(db.delete).mockReturnValue({ where: mockWhere } as never);
  });

  describe('purgeAiUsageLogs', () => {
    it('should delete rows older than the cutoff date', async () => {
      mockReturning.mockResolvedValue([{ id: 'log-1' }, { id: 'log-2' }]);

      const cutoff = new Date('2024-01-01');
      const count = await purgeAiUsageLogs(cutoff);

      expect(db.delete).toHaveBeenCalled();
      expect(count).toBe(2);
    });

    it('should return 0 when no records match', async () => {
      mockReturning.mockResolvedValue([]);

      const count = await purgeAiUsageLogs(new Date());

      expect(count).toBe(0);
    });

    it('should propagate database errors', async () => {
      mockReturning.mockRejectedValue(new Error('DB timeout'));

      await expect(purgeAiUsageLogs(new Date())).rejects.toThrow('DB timeout');
    });
  });

  describe('deleteAiUsageLogsForUser', () => {
    it('should delete all rows for the given userId', async () => {
      mockReturning.mockResolvedValue([
        { id: 'log-1' }, { id: 'log-2' }, { id: 'log-3' }, { id: 'log-4' },
      ]);

      const count = await deleteAiUsageLogsForUser('user-123');

      expect(db.delete).toHaveBeenCalled();
      expect(count).toBe(4);
    });

    it('should return 0 when user has no logs', async () => {
      mockReturning.mockResolvedValue([]);

      const count = await deleteAiUsageLogsForUser('user-no-logs');

      expect(count).toBe(0);
    });

    it('should propagate database errors', async () => {
      mockReturning.mockRejectedValue(new Error('Permission denied'));

      await expect(deleteAiUsageLogsForUser('user-123')).rejects.toThrow('Permission denied');
    });
  });
});
