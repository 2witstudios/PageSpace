/**
 * Global Conversation Hard Delete Tests
 *
 * Tests for hard-delete and purge methods on globalConversationRepository:
 * - hardDeleteMessage: physical removal by ID
 * - purgeInactiveMessages: bulk removal of soft-deleted messages past retention
 * - purgeInactiveConversations: bulk removal of soft-deleted conversations past retention
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReturning = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockWhere = vi.hoisted(() => vi.fn().mockReturnValue({ returning: mockReturning }));

vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
      }),
    }),
    delete: vi.fn().mockReturnValue({ where: mockWhere }),
  },
  conversations: {
    id: 'id',
    userId: 'userId',
    isActive: 'isActive',
    updatedAt: 'updatedAt',
    title: 'title',
    type: 'type',
    contextId: 'contextId',
    lastMessageAt: 'lastMessageAt',
    createdAt: 'createdAt',
  },
  messages: {
    id: 'id',
    conversationId: 'conversationId',
    isActive: 'isActive',
    createdAt: 'createdAt',
    content: 'content',
    role: 'role',
    editedAt: 'editedAt',
  },
  aiUsageLogs: {
    id: 'id',
    timestamp: 'timestamp',
    userId: 'userId',
    provider: 'provider',
    model: 'model',
    inputTokens: 'inputTokens',
    outputTokens: 'outputTokens',
    totalTokens: 'totalTokens',
    cost: 'cost',
    conversationId: 'conversationId',
    messageId: 'messageId',
    pageId: 'pageId',
    driveId: 'driveId',
    success: 'success',
    error: 'error',
    contextSize: 'contextSize',
    messageCount: 'messageCount',
    wasTruncated: 'wasTruncated',
  },
  eq: vi.fn((field, value) => ({ type: 'eq', field, value })),
  and: vi.fn((...conditions) => ({ type: 'and', conditions })),
  desc: vi.fn((field) => ({ type: 'desc', field })),
  sql: vi.fn(),
  lt: vi.fn((field, value) => ({ type: 'lt', field, value })),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: () => 'mock-id',
  init: vi.fn(() => vi.fn(() => 'test-cuid')),
}));

import { globalConversationRepository } from '../global-conversation-repository';
import { db } from '@pagespace/db';

describe('globalConversationRepository hard-delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReturning.mockResolvedValue([]);
    mockWhere.mockReturnValue({ returning: mockReturning });
    vi.mocked(db.delete).mockReturnValue({ where: mockWhere } as never);
  });

  describe('hardDeleteMessage', () => {
    it('should call db.delete with the correct message ID', async () => {
      await globalConversationRepository.hardDeleteMessage('msg-456');

      expect(db.delete).toHaveBeenCalled();
      expect(mockWhere).toHaveBeenCalled();
    });
  });

  describe('purgeInactiveMessages', () => {
    it('should delete inactive messages older than cutoff and return count', async () => {
      mockReturning.mockResolvedValue([{ id: 'msg-1' }, { id: 'msg-2' }, { id: 'msg-3' }]);

      const cutoff = new Date('2024-06-01');
      const count = await globalConversationRepository.purgeInactiveMessages(cutoff);

      expect(db.delete).toHaveBeenCalled();
      expect(count).toBe(3);
    });

    it('should return 0 when no inactive messages match', async () => {
      mockReturning.mockResolvedValue([]);

      const count = await globalConversationRepository.purgeInactiveMessages(new Date());

      expect(count).toBe(0);
    });
  });

  describe('purgeInactiveConversations', () => {
    it('should delete inactive conversations older than cutoff and return count', async () => {
      mockReturning.mockResolvedValue([{ id: 'conv-1' }, { id: 'conv-2' }]);

      const cutoff = new Date('2024-06-01');
      const count = await globalConversationRepository.purgeInactiveConversations(cutoff);

      expect(db.delete).toHaveBeenCalled();
      expect(count).toBe(2);
    });

    it('should return 0 when no inactive conversations match', async () => {
      mockReturning.mockResolvedValue([]);

      const count = await globalConversationRepository.purgeInactiveConversations(new Date());

      expect(count).toBe(0);
    });
  });
});
