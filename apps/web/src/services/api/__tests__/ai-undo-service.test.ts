/**
 * Contract tests for ai-undo-service.ts
 *
 * Tests the AI undo service's observable contracts:
 * - previewAiUndo: message lookup -> preview of affected messages and activities
 * - executeAiUndo: message + mode -> soft-delete messages + optional rollbacks
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  previewAiUndo,
  executeAiUndo,
} from '../ai-undo-service';
import type { RollbackResult } from '../rollback-service';
import type { ActivityActionPreview } from '../../../types/activity-actions';

// Mock the database
vi.mock('@pagespace/db/db', () => {
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
  };
});
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a, b) => ({ field: a, value: b })),
  and: vi.fn((...args) => args),
  gte: vi.fn((a, b) => ({ field: a, op: 'gte', value: b })),
  lt: vi.fn((a, b) => ({ field: a, op: 'lt', value: b })),
  desc: vi.fn((a) => ({ field: a, direction: 'desc' })),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  chatMessages: { id: 'id', conversationId: 'conversationId', createdAt: 'createdAt', isActive: 'isActive' },
}));
vi.mock('@pagespace/db/schema/monitoring', () => ({
  activityLogs: { id: 'id', aiConversationId: 'aiConversationId', isAiGenerated: 'isAiGenerated', timestamp: 'timestamp' },
}));
vi.mock('@pagespace/db/schema/conversations', () => ({
  messages: { id: 'id', conversationId: 'conversationId', createdAt: 'createdAt', isActive: 'isActive' },
}));

// Mock the rollback service
vi.mock('../rollback-service', () => ({
  executeRollback: vi.fn(),
  previewRollback: vi.fn(),
}));

// Mock activity logger
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
    logConversationUndo: vi.fn(),
    getActorInfo: vi.fn().mockResolvedValue({
    actorEmail: 'test@example.com',
    actorDisplayName: 'Test User',
  }),
}));

// Mock loggers
vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

import { db } from '@pagespace/db/db';
import { executeRollback, previewRollback } from '../rollback-service';
import { logConversationUndo } from '@pagespace/lib/monitoring/activity-logger';
import { loggers } from '@pagespace/lib/logging/logger-config';

/** Matches the mock shape defined in vi.mock('@pagespace/db') above */
type MockFn = ReturnType<typeof vi.fn>;
interface MockDb {
  query: {
    chatMessages: { findFirst: MockFn };
    messages: { findFirst: MockFn };
    pages: { findFirst: MockFn };
  };
  select: MockFn;
  update: MockFn;
  transaction: MockFn;
}

const mockDb = vi.mocked(db) as unknown as MockDb;
const mockPreviewRollback = vi.mocked(previewRollback);
const mockExecuteRollback = vi.mocked(executeRollback);
const mockLoggers = vi.mocked(loggers);

// Test fixtures
const mockUserId = 'user_123';
const mockMessageId = 'msg_123';
const mockConversationId = 'conv_123';
const mockPageId = 'page_123';
const mockDriveId = 'drive_123';

const createMockPreview = (overrides: Partial<ActivityActionPreview> = {}): ActivityActionPreview => ({
  action: 'rollback',
  canExecute: true,
  reason: undefined,
  warnings: [],
  hasConflict: false,
  conflictFields: [],
  requiresForce: false,
  isNoOp: false,
  currentValues: null,
  targetValues: null,
  changes: [],
  affectedResources: [],
  ...overrides,
});

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

const createMockRollbackResult = (overrides: Partial<RollbackResult> = {}): RollbackResult => ({
  action: 'rollback',
  status: 'success',
  success: true,
  message: 'OK',
  warnings: [],
  changesApplied: [],
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
      mockDb.query.chatMessages.findFirst.mockResolvedValue(null);

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

      mockDb.query.chatMessages.findFirst.mockResolvedValue(mockMessage);
      mockDb.query.pages.findFirst.mockResolvedValue({ driveId: mockDriveId });

      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(mockAffectedMessages),
        }),
      }));

      // For activities query (second db.select call)
      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => ({
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

      mockDb.query.chatMessages.findFirst.mockResolvedValue(mockMessage);
      mockDb.query.pages.findFirst.mockResolvedValue({ driveId: mockDriveId });

      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => ({
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
      mockPreviewRollback
        .mockResolvedValueOnce(createMockPreview({ canExecute: true }))
        .mockResolvedValueOnce(createMockPreview({ canExecute: false, reason: 'Cannot rollback create' }));

      const result = await previewAiUndo(mockMessageId, mockUserId);

      expect(result!.activitiesAffected).toHaveLength(2);
      expect(result!.activitiesAffected[0].preview.canExecute).toBe(true);
      expect(result!.activitiesAffected[1].preview.canExecute).toBe(false);
      expect(result!.activitiesAffected[1].preview.reason).toBe('Cannot rollback create');
    });

    it('includes warnings for non-rollbackable activities', async () => {
      const mockMessage = createMockMessage();
      const mockActivities = [
        createMockActivity({ id: 'act_1', operation: 'create', resourceTitle: 'New Page' }),
      ];

      mockDb.query.chatMessages.findFirst.mockResolvedValue(mockMessage);
      mockDb.query.pages.findFirst.mockResolvedValue({ driveId: mockDriveId });

      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => ({
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

      mockPreviewRollback.mockResolvedValue(
        createMockPreview({
          canExecute: false,
          reason: "Cannot rollback 'create' operations",
        })
      );

      const result = await previewAiUndo(mockMessageId, mockUserId);

      expect(result!.warnings.length).toBeGreaterThan(0);
      expect(result!.warnings[0]).toContain('Cannot undo');
    });

    it('returns null on error', async () => {
      mockDb.query.chatMessages.findFirst.mockRejectedValue(new Error('DB error'));

      const result = await previewAiUndo(mockMessageId, mockUserId);

      expect(result).toBeNull();
    });
  });

  // ============================================
  // executeAiUndo - messages_only mode
  // ============================================

  describe('executeAiUndo - messages_only mode', () => {
    it('returns failure when message not found', async () => {
      mockDb.query.chatMessages.findFirst.mockResolvedValue(null);

      const result = await executeAiUndo(mockMessageId, mockUserId, 'messages_only');

      expect(result.success).toBe(false);
      expect(result.errors).toContain('Message not found or preview failed');
    });

    it('soft-deletes messages without rolling back activities', async () => {
      const mockMessage = createMockMessage();

      mockDb.query.chatMessages.findFirst.mockResolvedValue(mockMessage);
      mockDb.query.pages.findFirst.mockResolvedValue({ driveId: mockDriveId });

      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => ({
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
      mockDb.transaction.mockImplementation(async (callback: (tx: Record<string, unknown>) => Promise<void>) => {
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

    it('logs debug message for secondary table soft-delete', async () => {
      const mockMessage = createMockMessage();

      mockDb.query.chatMessages.findFirst.mockResolvedValue(mockMessage);
      mockDb.query.pages.findFirst.mockResolvedValue({ driveId: mockDriveId });

      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => ({
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

      mockDb.transaction.mockImplementation(async (callback: (tx: Record<string, unknown>) => Promise<void>) => {
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

      const debugArgs = (mockLoggers.api.debug as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => call[0] === '[AiUndo:Execute] Soft-deleting from secondary table'
      );
      expect(debugArgs).toHaveLength(2);
      const debugData = debugArgs![1] as Record<string, unknown>;
      expect(debugData.secondaryTable).toBe('messages');
      expect(debugData.conversationId).toBe(mockConversationId);
    });

    it('logs conversation undo with correct mode', async () => {
      const mockMessage = createMockMessage();

      mockDb.query.chatMessages.findFirst.mockResolvedValue(mockMessage);
      mockDb.query.pages.findFirst.mockResolvedValue({ driveId: mockDriveId });

      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue([{ id: 'msg_1' }]),
        }),
      }));

      // Override for activities query
      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => ({
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

      mockDb.transaction.mockImplementation(async (callback: (tx: Record<string, unknown>) => Promise<void>) => {
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

      const undoArgs = vi.mocked(logConversationUndo).mock.calls[0];
      expect(undoArgs[0]).toBe(mockUserId);
      expect(undoArgs[1]).toBe(mockConversationId);
      expect(undoArgs[2]).toBe(mockMessageId);
      expect(undoArgs[3]).toEqual({ actorEmail: 'test@example.com', actorDisplayName: 'Test User' });
      const undoOptions = undoArgs[4] as Record<string, unknown>;
      expect(undoOptions.mode).toBe('messages_only');
      expect(undoOptions.messagesDeleted).toBe(1);
      expect(undoOptions.activitiesRolledBack).toBe(0);
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

      mockDb.query.chatMessages.findFirst.mockResolvedValue(mockMessage);
      mockDb.query.pages.findFirst.mockResolvedValue({ driveId: mockDriveId });

      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => ({
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

      mockPreviewRollback.mockResolvedValue(createMockPreview({ canExecute: true }));
      mockExecuteRollback.mockResolvedValue(createMockRollbackResult());

      mockDb.transaction.mockImplementation(async (callback: (tx: Record<string, unknown>) => Promise<void>) => {
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

      mockDb.query.chatMessages.findFirst.mockResolvedValue(mockMessage);
      mockDb.query.pages.findFirst.mockResolvedValue({ driveId: mockDriveId });

      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => ({
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

      mockPreviewRollback.mockResolvedValue(createMockPreview({ canExecute: true }));
      mockExecuteRollback
        .mockResolvedValueOnce(createMockRollbackResult())
        .mockResolvedValueOnce(createMockRollbackResult({ success: false, status: 'failed', message: 'Rollback failed' }));

      // Transaction should abort on failure
      mockDb.transaction.mockImplementation(async (callback: (tx: Record<string, unknown>) => Promise<void>) => {
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

      mockDb.query.chatMessages.findFirst.mockResolvedValue(mockMessage);
      mockDb.query.pages.findFirst.mockResolvedValue({ driveId: mockDriveId });

      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => ({
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

      mockPreviewRollback.mockResolvedValue(
        createMockPreview({
          canExecute: false,
          reason: "Cannot rollback 'create' operations",
        })
      );

      mockDb.transaction.mockImplementation(async (callback: (tx: Record<string, unknown>) => Promise<void>) => {
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

    it('proceeds when force=true and requiresForce=true', async () => {
      const mockMessage = createMockMessage();
      const mockActivities = [
        createMockActivity({ id: 'act_1', operation: 'update' }),
      ];

      mockDb.query.chatMessages.findFirst.mockResolvedValue(mockMessage);
      mockDb.query.pages.findFirst.mockResolvedValue({ driveId: mockDriveId });

      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => ({
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

      mockPreviewRollback.mockResolvedValue(
        createMockPreview({ canExecute: false, requiresForce: true, hasConflict: true, reason: 'Resource modified' })
      );
      mockExecuteRollback.mockResolvedValue(createMockRollbackResult());

      mockDb.transaction.mockImplementation(async (callback: (tx: Record<string, unknown>) => Promise<void>) => {
        const tx = {
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
          }),
        };
        await callback(tx);
      });

      const result = await executeAiUndo(mockMessageId, mockUserId, 'messages_and_changes', undefined, { force: true });

      expect(result.success).toBe(true);
      expect(result.activitiesRolledBack).toBe(1);
    });

    it('throws when force=true but requiresForce=false', async () => {
      const mockMessage = createMockMessage();
      const mockActivities = [
        createMockActivity({ id: 'act_1', operation: 'create', resourceTitle: 'New Item' }),
      ];

      mockDb.query.chatMessages.findFirst.mockResolvedValue(mockMessage);
      mockDb.query.pages.findFirst.mockResolvedValue({ driveId: mockDriveId });

      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => ({
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

      mockPreviewRollback.mockResolvedValue(
        createMockPreview({ canExecute: false, requiresForce: false, reason: "Cannot rollback 'create'" })
      );

      mockDb.transaction.mockImplementation(async (callback: (tx: Record<string, unknown>) => Promise<void>) => {
        try {
          await callback({});
        } catch (e) {
          throw e;
        }
      });

      const result = await executeAiUndo(mockMessageId, mockUserId, 'messages_and_changes', undefined, { force: true });

      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain('Cannot undo create on New Item');
    });

    it('logs conversation undo with rolled back activity IDs', async () => {
      const mockMessage = createMockMessage();
      const mockActivities = [createMockActivity({ id: 'act_1' })];

      mockDb.query.chatMessages.findFirst.mockResolvedValue(mockMessage);
      mockDb.query.pages.findFirst.mockResolvedValue({ driveId: mockDriveId });

      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => ({
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

      mockPreviewRollback.mockResolvedValue(createMockPreview({ canExecute: true }));
      mockExecuteRollback.mockResolvedValue(createMockRollbackResult());

      mockDb.transaction.mockImplementation(async (callback: (tx: Record<string, unknown>) => Promise<void>) => {
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

      const undoArgs2 = vi.mocked(logConversationUndo).mock.calls[0];
      expect(undoArgs2[0]).toBe(mockUserId);
      expect(undoArgs2[1]).toBe(mockConversationId);
      expect(undoArgs2[2]).toBe(mockMessageId);
      expect(undoArgs2[3]).toEqual({ actorEmail: 'test@example.com', actorDisplayName: 'Test User' });
      const undoOptions2 = undoArgs2[4] as Record<string, unknown>;
      expect(undoOptions2.mode).toBe('messages_and_changes');
      expect(undoOptions2.activitiesRolledBack).toBe(1);
      expect(undoOptions2.rolledBackActivityIds).toEqual(['act_1']);
    });
  });

  // ============================================
  // Error handling
  // ============================================

  describe('error handling', () => {
    it('returns failure on unexpected error', async () => {
      mockDb.query.chatMessages.findFirst.mockRejectedValue(new Error('Unexpected error'));

      const result = await executeAiUndo(mockMessageId, mockUserId, 'messages_only');

      expect(result.success).toBe(false);
      expect(result.errors).toContain('Message not found or preview failed');
    });

    it('handles transaction error gracefully', async () => {
      const mockMessage = createMockMessage();

      mockDb.query.chatMessages.findFirst.mockResolvedValue(mockMessage);
      mockDb.query.pages.findFirst.mockResolvedValue({ driveId: mockDriveId });

      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            return [{ id: 'msg_1' }];
          }),
        }),
      }));

      // Override for activities
      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => ({
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

      mockDb.transaction.mockRejectedValue(new Error('Transaction failed'));

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

      mockDb.query.chatMessages.findFirst.mockResolvedValue(mockMessage);
      mockDb.query.pages.findFirst.mockResolvedValue({ driveId: mockDriveId });

      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => ({
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

      mockDb.transaction.mockImplementation(async (callback: (tx: Record<string, unknown>) => Promise<void>) => {
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

    it('returns success without side effects when message already inactive (idempotent)', async () => {
      mockDb.query.chatMessages.findFirst.mockResolvedValue(
        createMockMessage({ isActive: false })
      );

      const result = await executeAiUndo(mockMessageId, mockUserId, 'messages_only');

      expect(result.success).toBe(true);
      expect(result.messagesDeleted).toBe(0);
      expect(result.activitiesRolledBack).toBe(0);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it('handles page without driveId (global assistant)', async () => {
      const mockMessage = createMockMessage();

      mockDb.query.chatMessages.findFirst.mockResolvedValue(mockMessage);
      mockDb.query.pages.findFirst.mockResolvedValue({ driveId: null });

      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => ({
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
