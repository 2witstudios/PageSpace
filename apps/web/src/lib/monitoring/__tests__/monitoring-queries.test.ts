import { describe, it, expect, vi } from 'vitest';

vi.mock('@pagespace/db', () => ({
  db: { select: vi.fn(), query: {} },
  apiMetrics: {},
  userActivities: {},
  aiUsageLogs: {},
  systemLogs: {},
  errorLogs: {},
  users: {},
  sql: vi.fn(),
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  gte: vi.fn(),
  lte: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
}));

import { getDateRange } from '../monitoring-queries';

describe('monitoring-queries', () => {
  describe('getDateRange', () => {
    it('should return 24h range', () => {
      const before = Date.now();
      const result = getDateRange('24h');
      expect(result.startDate).toBeInstanceOf(Date);
      expect(result.endDate).toBeInstanceOf(Date);
      const diff = result.endDate.getTime() - result.startDate!.getTime();
      expect(diff).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 100);
      expect(diff).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 100);
    });

    it('should return 7d range', () => {
      const result = getDateRange('7d');
      const diff = result.endDate.getTime() - result.startDate!.getTime();
      expect(diff).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000 - 100);
      expect(diff).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000 + 100);
    });

    it('should return 30d range', () => {
      const result = getDateRange('30d');
      const diff = result.endDate.getTime() - result.startDate!.getTime();
      expect(diff).toBeGreaterThanOrEqual(30 * 24 * 60 * 60 * 1000 - 100);
      expect(diff).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000 + 100);
    });

    it('should return undefined startDate for all range', () => {
      const result = getDateRange('all');
      expect(result.startDate).toBeUndefined();
      expect(result.endDate).toBeInstanceOf(Date);
    });
  });
});
