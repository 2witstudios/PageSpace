/**
 * Global Conversation Hard Delete Tests
 *
 * - purgeInactiveConversations: bulk removal of soft-deleted conversations past retention
 *
 * The MESSAGE purge and hard-delete that used to be pinned here moved to
 * message-repository.ts with the message-table merge (epic "Agent-Session
 * Single Source of Truth", Phase 4 / D6, PR 12) and are pinned by
 * message-repository-last-message-recompute.test.ts. What is left here is what
 * this repository still owns: `conversations` ROWS.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReturning = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockWhere = vi.hoisted(() => vi.fn().mockReturnValue({ returning: mockReturning }));
// recomputeLastMessageAt (#2153) locks the conversation row and runs inside
// its own transaction before reading the surviving messages — purge/delete
// paths that touch a real conversationId now go through this.
const mockTransaction = vi.hoisted(() => vi.fn());

vi.mock('@pagespace/db/db', () => {
  const dbShape = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          for: vi.fn().mockResolvedValue([]),
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
    transaction: mockTransaction,
  };
  mockTransaction.mockImplementation((cb: (tx: typeof dbShape) => unknown) => cb(dbShape));
  return { db: dbShape };
});
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field, value) => ({ type: 'eq', field, value })),
  and: vi.fn((...conditions) => ({ type: 'and', conditions })),
  desc: vi.fn((field) => ({ type: 'desc', field })),
  sql: vi.fn(),
  lt: vi.fn((field, value) => ({ type: 'lt', field, value })),
  exists: vi.fn((sub) => ({ type: 'exists', sub })),
}));
vi.mock('@pagespace/db/schema/monitoring', () => ({
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
}));
vi.mock('@pagespace/db/schema/conversations', () => ({
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
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: () => 'mock-id',
  init: vi.fn(() => vi.fn(() => 'test-cuid')),
}));

import { globalConversationRepository } from '../global-conversation-repository';
import { db } from '@pagespace/db/db';

describe('globalConversationRepository hard-delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReturning.mockResolvedValue([]);
    mockWhere.mockReturnValue({ returning: mockReturning });
    vi.mocked(db.delete).mockReturnValue({ where: mockWhere } as never);
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
