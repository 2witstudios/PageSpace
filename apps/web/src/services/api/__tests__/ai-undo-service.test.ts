/**
 * @scaffold - mocking ORM chains until repository seam is introduced
 *
 * Contract tests for ai-undo-service.ts
 *
 * Tests the AI undo service's observable contracts:
 * - previewAiUndo: message lookup -> preview of affected messages and activities
 * - executeAiUndo: message + mode -> soft-delete messages + optional rollbacks
 *
 * User stories:
 * - As a user in AI chat, I can undo from a message to remove all subsequent messages
 * - As a user, I can choose to also undo all AI tool side effects
 * - As a user, I see what will be affected before confirming
 *
 * Note: This test uses order-dependent ORM chain mocks (selectCallCount pattern)
 * which encode internal query order. Consider introducing a chat-message-repository
 * seam to improve testability and refactor-resistance.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import {
  previewAiUndo,
  executeAiUndo,
} from '../ai-undo-service';

// Mock the database
vi.mock('@pagespace/db', () => {
  const mockDb = {
    query: {
      chatMessages: {
        findFirst: vi.fn(),
      },
      messages: {
        findFirst: vi.fn(),
      },
      pages: {
        findFirst: vi.fn(),
      },
    },
    select: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  };

  return {
    db: mockDb,
    chatMessages: { id: 'id', conversationId: 'conversationId', createdAt: 'createdAt', isActive: 'isActive' },
    activityLogs: { id: 'id', aiConversationId: 'aiConversationId', isAiGenerated: 'isAiGenerated', timestamp: 'timestamp' },
    eq: vi.fn((a, b) => ({ field: a, value: b })),
    and: vi.fn((...args) => args),
    gte: vi.fn((a, b) => ({ field: a, op: 'gte', value: b })),
    lt: vi.fn((a, b) => ({ field: a, op: 'lt', value: b })),
    desc: vi.fn((a) => ({ field: a, direction: 'desc' })),
  };
});

// Mock the rollback service
vi.mock('../rollback-service', () => ({
  executeRollback: vi.fn(),
  previewRollback: vi.fn(),
}));

// Mock activity logger
vi.mock('@pagespace/lib/monitoring', () => ({
  logConversationUndo: vi.fn(),
  getActorInfo: vi.fn().mockResolvedValue({
    actorEmail: 'test@example.com',
    actorDisplayName: 'Test User',
  }),
}));

// Mock loggers
vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

import { db } from '@pagespace/db';
import { executeRollback, previewRollback } from '../rollback-service';
import { logConversationUndo } from '@pagespace/lib/monitoring';

// Test fixtures
const mockUserId = 'user_123';
const mockMessageId = 'msg_123';
const mockConversationId = 'conv_123';
const mockPageId = 'page_123';
const mockDriveId = 'drive_123';

const createMockMessage = (overrides = {}) => ({
  id: mockMessageId,
  conversationId: mockConversationId,
  pageId: mockPageId,
  createdAt: new Date('2024-01-15T10:00:00Z'),
  role: 'user',
  content: 'Test message',
  isActive: true,
  ...overrides,
});

const createMockActivity = (overrides = {}) => ({
  id: 'activity_123',
  operation: 'update',
  resourceType: 'page',
  resourceId: mockPageId,
  resourceTitle: 'Test Page',
  isAiGenerated: true,
  aiConversationId: mockConversationId,
  timestamp: new Date('2024-01-15T10:05:00Z'),
  ...overrides,
});

describe('ai-undo-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================
  // previewAiUndo
  // ============================================

  describe('previewAiUndo', () => {
    it('returns null when message not found', async () => {
      (db.query.chatMessages.findFirst as Mock).mockResolvedValue(null);

      const result = await previewAiUndo('nonexistent', mockUserId);

      expect(result).toBeNull();
    });

    it('returns preview with message count when message found', async () => {
      const mockMessage = createMockMessage();
      const mockAffectedMessages = [
        { id: 'msg_1' },
        { id: 'msg_2' },
        { id: 'msg_3' },
      ];

      (db.query.chatMessages.findFirst as Mock).mockResolvedValue(mockMessage);
      (db.query.pages.findFirst as Mock).mockResolvedValue({ driveId: mockDriveId });

      (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(mockAffectedMessages),
        }),
      }));

      // For activities query (second db.select call)
      let selectCallCount = 0;
      (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) {
              return mockAffectedMessages;
            }
            return {
              orderBy: vi.fn().mockResolvedValue([]),
            };
          }),
        }),
      }));

      const result = await previewAiUndo(mockMessageId, mockUserId);

      expect(result).not.toBeNull();
      expect(result!.messageId).toBe(mockMessageId);
      expect(result!.conversationId).toBe(mockConversationId);
      expect(result!.pageId).toBe(mockPageId);
      expect(result!.messagesAffected).toBe(3);
    });

    it('includes AI activities with rollback eligibility', async () => {
      const mockMessage = createMockMessage();
      const mockActivities = [
        createMockActivity({ id: 'act_1', operation: 'update' }),
        createMockActivity({ id: 'act_2', operation: 'create' }),
      ];

      (db.query.chatMessages.findFirst as Mock).mockResolvedValue(mockMessage);
      (db.query.pages.findFirst as Mock).mockResolvedValue({ driveId: mockDriveId });

      let selectCallCount = 0;
      (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) {
              return [{ id: 'msg_1' }];
            }
            return {
              orderBy: vi.fn().mockResolvedValue(mockActivities),
            };
          }),
        }),
      }));

      // Mock preview for each activity
      (previewRollback as Mock)
        .mockResolvedValueOnce({ canRollback: true, warnings: [] })
        .mockResolvedValueOnce({ canRollback: false, reason: 'Cannot rollback create', warnings: [] });

      const result = await previewAiUndo(mockMessageId, mockUserId);

      expect(result!.activitiesAffected).toHaveLength(2);
      expect(result!.activitiesAffected[0].canRollback).toBe(true);
      expect(result!.activitiesAffected[1].canRollback).toBe(false);
      expect(result!.activitiesAffected[1].reason).toBe('Cannot rollback create');
    });

    it('includes warnings for non-rollbackable activities', async () => {
      const mockMessage = createMockMessage();
      const mockActivities = [
        createMockActivity({ id: 'act_1', operation: 'create', resourceTitle: 'New Page' }),
      ];

      (db.query.chatMessages.findFirst as Mock).mockResolvedValue(mockMessage);
      (db.query.pages.findFirst as Mock).mockResolvedValue({ driveId: mockDriveId });

      let selectCallCount = 0;
      (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) {
              return [{ id: 'msg_1' }];
            }
            return {
              orderBy: vi.fn().mockResolvedValue(mockActivities),
            };
          }),
        }),
      }));

      (previewRollback as Mock).mockResolvedValue({
        canRollback: false,
        reason: "Cannot rollback 'create' operations",
        warnings: [],
      });

      const result = await previewAiUndo(mockMessageId, mockUserId);

      expect(result!.warnings.length).toBeGreaterThan(0);
      expect(result!.warnings[0]).toContain('Cannot undo');
    });

    it('returns null on error', async () => {
      (db.query.chatMessages.findFirst as Mock).mockRejectedValue(new Error('DB error'));

      const result = await previewAiUndo(mockMessageId, mockUserId);

      expect(result).toBeNull();
    });
  });

  // ============================================
  // executeAiUndo - messages_only mode
  // ============================================

  describe('executeAiUndo - messages_only mode', () => {
    it('returns failure when message not found', async () => {
      (db.query.chatMessages.findFirst as Mock).mockResolvedValue(null);

      const result = await executeAiUndo(mockMessageId, mockUserId, 'messages_only');

      expect(result.success).toBe(false);
      expect(result.errors).toContain('Message not found or preview failed');
    });

    it('soft-deletes messages without rolling back activities', async () => {
      const mockMessage = createMockMessage();

      (db.query.chatMessages.findFirst as Mock).mockResolvedValue(mockMessage);
      (db.query.pages.findFirst as Mock).mockResolvedValue({ driveId: mockDriveId });

      let selectCallCount = 0;
      (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) {
              return [{ id: 'msg_1' }, { id: 'msg_2' }];
            }
            return {
              orderBy: vi.fn().mockResolvedValue([]),
            };
          }),
        }),
      }));

      // Mock transaction
      (db.transaction as Mock).mockImplementation(async (callback) => {
        const tx = {
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
          }),
        };
        await callback(tx);
      });

      const result = await executeAiUndo(mockMessageId, mockUserId, 'messages_only');

      expect(result.success).toBe(true);
      expect(result.messagesDeleted).toBe(2);
      expect(result.activitiesRolledBack).toBe(0);
      expect(executeRollback).not.toHaveBeenCalled();
    });

    it('logs conversation undo with correct mode', async () => {
      const mockMessage = createMockMessage();

      (db.query.chatMessages.findFirst as Mock).mockResolvedValue(mockMessage);
      (db.query.pages.findFirst as Mock).mockResolvedValue({ driveId: mockDriveId });

      (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue([{ id: 'msg_1' }]),
        }),
      }));

      // Override for activities query
      let selectCallCount = 0;
      (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) {
              return [{ id: 'msg_1' }];
            }
            return {
              orderBy: vi.fn().mockResolvedValue([]),
            };
          }),
        }),
      }));

      (db.transaction as Mock).mockImplementation(async (callback) => {
        const tx = {
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
          }),
        };
        await callback(tx);
      });

      await executeAiUndo(mockMessageId, mockUserId, 'messages_only');

      expect(logConversationUndo).toHaveBeenCalledWith(
        mockUserId,
        mockConversationId,
        mockMessageId,
        expect.objectContaining({ actorEmail: 'test@example.com' }),
        expect.objectContaining({
          mode: 'messages_only',
          messagesDeleted: 1,
          activitiesRolledBack: 0,
        })
      );
    });
  });

  // ============================================
  // executeAiUndo - messages_and_changes mode
  // ============================================

  describe('executeAiUndo - messages_and_changes mode', () => {
    it('rolls back all activities in addition to deleting messages', async () => {
      const mockMessage = createMockMessage();
      const mockActivities = [
        createMockActivity({ id: 'act_1' }),
        createMockActivity({ id: 'act_2' }),
      ];

      (db.query.chatMessages.findFirst as Mock).mockResolvedValue(mockMessage);
      (db.query.pages.findFirst as Mock).mockResolvedValue({ driveId: mockDriveId });

      let selectCallCount = 0;
      (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1 || selectCallCount === 3) {
              return [{ id: 'msg_1' }];
            }
            return {
              orderBy: vi.fn().mockResolvedValue(mockActivities),
            };
          }),
        }),
      }));

      (previewRollback as Mock).mockResolvedValue({ canRollback: true, warnings: [] });
      (executeRollback as Mock).mockResolvedValue({ success: true });

      (db.transaction as Mock).mockImplementation(async (callback) => {
        const tx = {
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
          }),
        };
        await callback(tx);
      });

      const result = await executeAiUndo(mockMessageId, mockUserId, 'messages_and_changes');

      expect(result.success).toBe(true);
      expect(result.activitiesRolledBack).toBe(2);
      expect(executeRollback).toHaveBeenCalledTimes(2);
    });

    it('uses transaction for atomicity - all or nothing', async () => {
      const mockMessage = createMockMessage();
      const mockActivities = [
        createMockActivity({ id: 'act_1' }),
        createMockActivity({ id: 'act_2' }),
      ];

      (db.query.chatMessages.findFirst as Mock).mockResolvedValue(mockMessage);
      (db.query.pages.findFirst as Mock).mockResolvedValue({ driveId: mockDriveId });

      let selectCallCount = 0;
      (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1 || selectCallCount === 3) {
              return [{ id: 'msg_1' }];
            }
            return {
              orderBy: vi.fn().mockResolvedValue(mockActivities),
            };
          }),
        }),
      }));

      (previewRollback as Mock).mockResolvedValue({ canRollback: true, warnings: [] });
      (executeRollback as Mock)
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: false, message: 'Rollback failed' });

      // Transaction should abort on failure
      (db.transaction as Mock).mockImplementation(async (callback) => {
        const tx = {
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
          }),
        };
        try {
          await callback(tx);
        } catch (e) {
          throw e;
        }
      });

      const result = await executeAiUndo(mockMessageId, mockUserId, 'messages_and_changes');

      expect(result.success).toBe(false);
      expect(result.errors).toContain('Failed to undo update on Test Page: Rollback failed');
    });

    it('aborts transaction when activity cannot be rolled back', async () => {
      const mockMessage = createMockMessage();
      const mockActivities = [
        createMockActivity({ id: 'act_1', operation: 'create', resourceTitle: 'New Thing' }),
      ];

      (db.query.chatMessages.findFirst as Mock).mockResolvedValue(mockMessage);
      (db.query.pages.findFirst as Mock).mockResolvedValue({ driveId: mockDriveId });

      let selectCallCount = 0;
      (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1 || selectCallCount === 3) {
              return [{ id: 'msg_1' }];
            }
            return {
              orderBy: vi.fn().mockResolvedValue(mockActivities),
            };
          }),
        }),
      }));

      (previewRollback as Mock).mockResolvedValue({
        canRollback: false,
        reason: "Cannot rollback 'create' operations",
        warnings: [],
      });

      (db.transaction as Mock).mockImplementation(async (callback) => {
        const tx = {};
        try {
          await callback(tx);
        } catch (e) {
          throw e;
        }
      });

      const result = await executeAiUndo(mockMessageId, mockUserId, 'messages_and_changes');

      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain('Cannot undo create on New Thing');
    });

    it('logs conversation undo with rolled back activity IDs', async () => {
      const mockMessage = createMockMessage();
      const mockActivities = [createMockActivity({ id: 'act_1' })];

      (db.query.chatMessages.findFirst as Mock).mockResolvedValue(mockMessage);
      (db.query.pages.findFirst as Mock).mockResolvedValue({ driveId: mockDriveId });

      let selectCallCount = 0;
      (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1 || selectCallCount === 3) {
              return [{ id: 'msg_1' }];
            }
            return {
              orderBy: vi.fn().mockResolvedValue(mockActivities),
            };
          }),
        }),
      }));

      (previewRollback as Mock).mockResolvedValue({ canRollback: true, warnings: [] });
      (executeRollback as Mock).mockResolvedValue({ success: true });

      (db.transaction as Mock).mockImplementation(async (callback) => {
        const tx = {
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
          }),
        };
        await callback(tx);
      });

      await executeAiUndo(mockMessageId, mockUserId, 'messages_and_changes');

      expect(logConversationUndo).toHaveBeenCalledWith(
        mockUserId,
        mockConversationId,
        mockMessageId,
        expect.any(Object),
        expect.objectContaining({
          mode: 'messages_and_changes',
          activitiesRolledBack: 1,
          rolledBackActivityIds: ['act_1'],
        })
      );
    });
  });

  // ============================================
  // Error handling
  // ============================================

  describe('error handling', () => {
    it('returns failure on unexpected error', async () => {
      (db.query.chatMessages.findFirst as Mock).mockRejectedValue(new Error('Unexpected error'));

      const result = await executeAiUndo(mockMessageId, mockUserId, 'messages_only');

      expect(result.success).toBe(false);
      expect(result.errors).toContain('Message not found or preview failed');
    });

    it('handles transaction error gracefully', async () => {
      const mockMessage = createMockMessage();

      (db.query.chatMessages.findFirst as Mock).mockResolvedValue(mockMessage);
      (db.query.pages.findFirst as Mock).mockResolvedValue({ driveId: mockDriveId });

      (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            return [{ id: 'msg_1' }];
          }),
        }),
      }));

      // Override for activities
      let selectCallCount = 0;
      (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) {
              return [{ id: 'msg_1' }];
            }
            return {
              orderBy: vi.fn().mockResolvedValue([]),
            };
          }),
        }),
      }));

      (db.transaction as Mock).mockRejectedValue(new Error('Transaction failed'));

      const result = await executeAiUndo(mockMessageId, mockUserId, 'messages_only');

      expect(result.success).toBe(false);
      expect(result.errors).toContain('Transaction failed');
    });
  });

  // ============================================
  // Edge cases
  // ============================================

  describe('edge cases', () => {
    it('handles message with no subsequent messages', async () => {
      const mockMessage = createMockMessage();

      (db.query.chatMessages.findFirst as Mock).mockResolvedValue(mockMessage);
      (db.query.pages.findFirst as Mock).mockResolvedValue({ driveId: mockDriveId });

      let selectCallCount = 0;
      (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) {
              return [{ id: mockMessageId }]; // Only the message itself
            }
            return {
              orderBy: vi.fn().mockResolvedValue([]),
            };
          }),
        }),
      }));

      (db.transaction as Mock).mockImplementation(async (callback) => {
        const tx = {
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
          }),
        };
        await callback(tx);
      });

      const result = await executeAiUndo(mockMessageId, mockUserId, 'messages_only');

      expect(result.success).toBe(true);
      expect(result.messagesDeleted).toBe(1);
    });

    it('handles page without driveId (global assistant)', async () => {
      const mockMessage = createMockMessage();

      (db.query.chatMessages.findFirst as Mock).mockResolvedValue(mockMessage);
      (db.query.pages.findFirst as Mock).mockResolvedValue({ driveId: null });

      let selectCallCount = 0;
      (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) {
              return [{ id: 'msg_1' }];
            }
            return {
              orderBy: vi.fn().mockResolvedValue([]),
            };
          }),
        }),
      }));

      const result = await previewAiUndo(mockMessageId, mockUserId);

      expect(result).not.toBeNull();
      expect(result!.driveId).toBeNull();
    });
  });
});
