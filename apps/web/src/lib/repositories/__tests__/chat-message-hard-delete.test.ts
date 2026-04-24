/**
 * Chat Message Hard Delete Tests
 *
 * Tests for hard-delete and purge methods on chatMessageRepository:
 * - hardDeleteMessage: physical removal by ID
 * - purgeInactiveMessages: bulk removal of soft-deleted messages past retention
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReturning = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockWhere = vi.hoisted(() => vi.fn().mockReturnValue({ returning: mockReturning }));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    }),
    delete: vi.fn().mockReturnValue({ where: mockWhere }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field, value) => ({ type: 'eq', field, value })),
  and: vi.fn((...conditions) => ({ type: 'and', conditions })),
  lt: vi.fn((field, value) => ({ type: 'lt', field, value })),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  chatMessages: {
    id: 'id',
    pageId: 'pageId',
    conversationId: 'conversationId',
    isActive: 'isActive',
    createdAt: 'createdAt',
    content: 'content',
    editedAt: 'editedAt',
  },
}));

import { chatMessageRepository } from '../chat-message-repository';
import { db } from '@pagespace/db/db';

describe('chatMessageRepository hard-delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReturning.mockResolvedValue([]);
    mockWhere.mockReturnValue({ returning: mockReturning });
    vi.mocked(db.delete).mockReturnValue({ where: mockWhere } as never);
  });

  describe('hardDeleteMessage', () => {
    it('should call db.delete with the correct message ID', async () => {
      await chatMessageRepository.hardDeleteMessage('msg-123');

      expect(db.delete).toHaveBeenCalled();
      expect(mockWhere).toHaveBeenCalled();
    });
  });

  describe('purgeInactiveMessages', () => {
    it('should delete inactive messages older than cutoff and return count', async () => {
      mockReturning.mockResolvedValue([{ id: 'msg-1' }, { id: 'msg-2' }]);

      const cutoff = new Date('2024-06-01');
      const count = await chatMessageRepository.purgeInactiveMessages(cutoff);

      expect(db.delete).toHaveBeenCalled();
      expect(count).toBe(2);
    });

    it('should return 0 when no inactive messages match', async () => {
      mockReturning.mockResolvedValue([]);

      const count = await chatMessageRepository.purgeInactiveMessages(new Date());

      expect(count).toBe(0);
    });
  });
});
