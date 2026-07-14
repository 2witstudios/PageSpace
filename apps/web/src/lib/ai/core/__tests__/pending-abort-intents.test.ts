import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { recordPendingAbort, consumePendingAbort, clearPendingAbort, PENDING_ABORT_INTENT_TTL_MS } from '@/lib/ai/core/pending-abort-intents';

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
});
