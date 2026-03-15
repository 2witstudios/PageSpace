/**
 * AI Usage Purge Tests
 *
 * Tests for AI usage log lifecycle functions:
 * - Content anonymization (TTL-based)
 * - Full row purge (TTL-based)
 * - User-scoped deletion (account deletion)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * and db.delete().where().returning()
 * Pure functions (lt, eq, and, or, isNotNull) are mocked because they are
 * re-exported from @pagespace/db and used as query-builder arguments.
 */
const mockReturning = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockWhere = vi.hoisted(() => vi.fn().mockReturnValue({ returning: mockReturning }));
const mockSet = vi.hoisted(() => vi.fn().mockReturnValue({ where: mockWhere }));

vi.mock('@pagespace/db', () => ({
  db: {
    update: vi.fn().mockReturnValue({ set: mockSet }),
    delete: vi.fn().mockReturnValue({ where: mockWhere }),
  },
  aiUsageLogs: {
    id: 'id',
    prompt: 'prompt',
    completion: 'completion',
    timestamp: 'timestamp',
    userId: 'userId',
  },
  lt: vi.fn((field, value) => ({ type: 'lt', field, value })),
  eq: vi.fn((field, value) => ({ type: 'eq', field, value })),
  and: vi.fn((...conditions) => ({ type: 'and', conditions })),
  or: vi.fn((...conditions) => ({ type: 'or', conditions })),
  isNotNull: vi.fn((field) => ({ type: 'isNotNull', field })),
}));

import {
  anonymizeAiUsageContent,
  purgeAiUsageLogs,
  deleteAiUsageLogsForUser,
} from '../ai-usage-purge';
import { db } from '@pagespace/db';

describe('ai-usage-purge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default chain behavior
    mockReturning.mockResolvedValue([]);
    mockWhere.mockReturnValue({ returning: mockReturning });
    mockSet.mockReturnValue({ where: mockWhere });
    vi.mocked(db.update).mockReturnValue({ set: mockSet } as never);
    vi.mocked(db.delete).mockReturnValue({ where: mockWhere } as never);
  });

  describe('anonymizeAiUsageContent', () => {
    it('should update prompt and completion to null for old records', async () => {
      mockReturning.mockResolvedValue([{ id: 'log-1' }, { id: 'log-2' }, { id: 'log-3' }]);

      const cutoff = new Date('2024-01-01');
      const count = await anonymizeAiUsageContent(cutoff);

      expect(db.update).toHaveBeenCalledTimes(1);
      expect(mockSet).toHaveBeenCalledWith({ prompt: null, completion: null });
      expect(count).toBe(3);
    });

    it('should return 0 when no records match', async () => {
      mockReturning.mockResolvedValue([]);

      const count = await anonymizeAiUsageContent(new Date());

      expect(count).toBe(0);
    });

    it('should propagate database errors', async () => {
      mockReturning.mockRejectedValue(new Error('DB connection lost'));

      await expect(anonymizeAiUsageContent(new Date())).rejects.toThrow('DB connection lost');
    });
  });

  describe('purgeAiUsageLogs', () => {
    it('should delete rows older than the cutoff date', async () => {
      mockReturning.mockResolvedValue([{ id: 'log-1' }, { id: 'log-2' }]);

      const cutoff = new Date('2024-01-01');
      const count = await purgeAiUsageLogs(cutoff);

      expect(db.delete).toHaveBeenCalledTimes(1);
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

      expect(db.delete).toHaveBeenCalledTimes(1);
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
