import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockInsert, mockDelete, mockLogger } = vi.hoisted(() => ({
  mockInsert: {
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
  },
  mockDelete: {
    where: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([]),
    }),
  },
  mockLogger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    insert: vi.fn(() => mockInsert),
    delete: vi.fn(() => mockDelete),
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ type: 'eq', a, b })),
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  lt: vi.fn((a: unknown, b: unknown) => ({ type: 'lt', a, b })),
}));

vi.mock('@pagespace/db/schema/ai-streams', () => ({
  aiPendingAbortIntents: {
    conversationId: 'conversation_id',
    userId: 'user_id',
    createdAt: 'created_at',
  },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: mockLogger },
}));

import {
  recordPendingAbort,
  consumePendingAbort,
  clearPendingAbort,
  sweepExpiredPendingAbortIntents,
  PENDING_ABORT_INTENT_TTL_MS,
} from '@/lib/ai/core/pending-abort-intents';

describe('pending-abort-intents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsert.values.mockReturnThis();
    mockInsert.onConflictDoUpdate.mockResolvedValue(undefined);
    mockDelete.where.mockReturnValue({
      returning: vi.fn().mockResolvedValue([]),
    });
  });

  describe('recordPendingAbort', () => {
    it('inserts with onConflictDoUpdate to upsert', async () => {
      const now = new Date('2026-01-01T00:00:00Z');
      await recordPendingAbort({ conversationId: 'conv1', userId: 'user1', now });

      expect(mockInsert.values).toHaveBeenCalledWith({
        conversationId: 'conv1',
        userId: 'user1',
        createdAt: now,
      });
      expect(mockInsert.onConflictDoUpdate).toHaveBeenCalledTimes(1);
    });

    it('swallows DB errors without throwing', async () => {
      mockInsert.onConflictDoUpdate.mockRejectedValueOnce(new Error('DB down'));

      await expect(recordPendingAbort({ conversationId: 'conv1', userId: 'user1' }))
        .resolves.toBeUndefined();
    });
  });

  describe('consumePendingAbort', () => {
    it('returns true when a fresh intent is consumed', async () => {
      mockDelete.where.mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ createdAt: new Date() }]),
      });

      const result = await consumePendingAbort({ conversationId: 'conv1', userId: 'user1' });
      expect(result).toBe(true);
    });

    it('returns false when no intent exists', async () => {
      mockDelete.where.mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      });

      const result = await consumePendingAbort({ conversationId: 'conv1', userId: 'user1' });
      expect(result).toBe(false);
    });

    it('returns false for an expired intent but still consumes it', async () => {
      const oldDate = new Date(Date.now() - PENDING_ABORT_INTENT_TTL_MS - 1000);
      mockDelete.where.mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ createdAt: oldDate }]),
      });

      const result = await consumePendingAbort({ conversationId: 'conv1', userId: 'user1' });
      expect(result).toBe(false);
    });

    it('returns false on DB error without throwing', async () => {
      mockDelete.where.mockReturnValue({
        returning: vi.fn().mockRejectedValue(new Error('DB down')),
      });

      const result = await consumePendingAbort({ conversationId: 'conv1', userId: 'user1' });
      expect(result).toBe(false);
    });
  });

  describe('clearPendingAbort', () => {
    it('deletes without throwing on error', async () => {
      mockDelete.where.mockReturnValue({
        returning: vi.fn().mockRejectedValue(new Error('DB down')),
      });

      await expect(clearPendingAbort({ conversationId: 'conv1', userId: 'user1' }))
        .resolves.toBeUndefined();
    });
  });

  // Reaps intents never consumed by a later createStreamLifecycle call — e.g. the user pressed
  // Stop during preflight and never sent another message on that conversation. Run from the
  // generic /api/cron/sweep-expired route alongside sweepExpiredRateLimitBuckets et al.
  describe('sweepExpiredPendingAbortIntents', () => {
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      vi.stubEnv('NODE_ENV', originalNodeEnv ?? 'test');
    });

    it('deletes rows older than the TTL and returns the row count', async () => {
      mockDelete.where.mockResolvedValue({ rowCount: 4 });

      const result = await sweepExpiredPendingAbortIntents();

      expect(result).toBe(4);
      expect(mockDelete.where).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'lt', a: 'created_at' }),
      );
    });

    it('returns 0 when rowCount is null', async () => {
      mockDelete.where.mockResolvedValue({ rowCount: null });

      const result = await sweepExpiredPendingAbortIntents();

      expect(result).toBe(0);
    });

    it('swallows DB errors and returns 0 outside production', async () => {
      vi.stubEnv('NODE_ENV', 'test');
      mockDelete.where.mockRejectedValue(new Error('DB down'));

      await expect(sweepExpiredPendingAbortIntents()).resolves.toBe(0);
    });

    it('re-throws DB errors in production so the cron handler can surface a 500', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      mockDelete.where.mockRejectedValue(new Error('DB down'));

      await expect(sweepExpiredPendingAbortIntents()).rejects.toThrow('DB down');
    });
  });
});
