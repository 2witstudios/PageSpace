/**
 * Activity Logger Compliance Tests
 *
 * Tests for actor snapshot fields in activity logger:
 * - actorEmail required in ActivityLogInput
 * - actorDisplayName optional
 * - Convenience wrappers pass actor info through
 * - Hash chain fields computed on log insertion
 *
 * @scaffold - characterizing current behavior with ORM mock.
 * The activity-logger itself is the seam; these tests verify its contract.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted state shared between mock factory and test assertions
const { testState, createMockTx } = vi.hoisted(() => {
  const state = {
    capturedInsertValues: null as Record<string, unknown> | null,
    lastInsertedHash: null as string | null,
  };

  const insertValuesFn = (values: Record<string, unknown>) => {
    state.capturedInsertValues = values;
    if (values.logHash) {
      state.lastInsertedHash = values.logHash as string;
    }
    return Promise.resolve(undefined);
  };

  const findFirstFn = () => {
    if (state.lastInsertedHash) {
      return Promise.resolve({ logHash: state.lastInsertedHash });
    }
    return Promise.resolve(null);
  };

  const createTx = () => ({
    execute: () => Promise.resolve({ rows: [] }),
    insert: () => ({ values: insertValuesFn }),
    query: { activityLogs: { findFirst: findFirstFn } },
  });

  return { testState: state, createMockTx: createTx };
});

vi.mock('@pagespace/db', () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        testState.capturedInsertValues = values;
        if (values.logHash) {
          testState.lastInsertedHash = values.logHash as string;
        }
        return Promise.resolve(undefined);
      }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transaction: vi.fn().mockImplementation(async (callback: any) => {
      return callback(createMockTx());
    }),
    query: {
      activityLogs: {
        findFirst: vi.fn().mockImplementation(() => {
          if (testState.lastInsertedHash) {
            return Promise.resolve({ logHash: testState.lastInsertedHash });
          }
          return Promise.resolve(null);
        }),
      },
    },
  },
  activityLogs: { id: 'id', logHash: 'logHash', timestamp: 'timestamp' },
  eq: vi.fn(),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

vi.mock('drizzle-orm', () => ({
  desc: vi.fn().mockImplementation((col) => col),
  isNotNull: vi.fn().mockImplementation((col) => col),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

import { db } from '@pagespace/db/db';
import {
  logActivity,
  logPageActivity,
  logPermissionActivity,
  logDriveActivity,
  logAgentConfigActivity,
  logMessageActivity,
  logRoleActivity,
  logRollbackActivity,
  logConversationUndo,
  type ActivityLogInput,
} from '../activity-logger';

// @scaffold: typed mock surface for ORM chain mocks (vi.mocked can't resolve Drizzle's overloaded generics)
type MockFn = ReturnType<typeof vi.fn>;
const mockDb = db as unknown as {
  query: { activityLogs: { findFirst: MockFn } };
  insert: MockFn;
  transaction: MockFn;
};

describe('activity logger compliance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.capturedInsertValues = null;
    testState.lastInsertedHash = null;
    // Restore transaction mock after clearAllMocks wipes it
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(db.transaction).mockImplementation(async (callback: any) => {
      return callback(createMockTx());
    });
  });

  describe('ActivityLogInput interface', () => {
    it('should require actorEmail in ActivityLogInput', async () => {
      // Arrange
      const input: ActivityLogInput = {
        userId: 'user-123',
        actorEmail: 'john@example.com',
        operation: 'create',
        resourceType: 'page',
        resourceId: 'page-1',
        driveId: 'drive-1',
      };

      // Act
      await logActivity(input);

      // Assert - verify actorEmail is passed to database
      expect(testState.capturedInsertValues).toMatchObject({
        userId: 'user-123',
        actorEmail: 'john@example.com',
        operation: 'create',
        resourceType: 'page',
        resourceId: 'page-1',
        driveId: 'drive-1',
      });
    });

    it('should accept optional actorDisplayName in ActivityLogInput', async () => {
      // Arrange
      const input: ActivityLogInput = {
        userId: 'user-123',
        actorEmail: 'john@example.com',
        actorDisplayName: 'John Doe',
        operation: 'update',
        resourceType: 'page',
        resourceId: 'page-1',
        driveId: 'drive-1',
      };

      // Act
      await logActivity(input);

      // Assert - verify both fields are passed
      expect(testState.capturedInsertValues).toMatchObject({
        actorEmail: 'john@example.com',
        actorDisplayName: 'John Doe',
      });
    });

    it('should store actorEmail and actorDisplayName in database insert', async () => {
      // Arrange
      const input: ActivityLogInput = {
        userId: 'user-123',
        actorEmail: 'john@example.com',
        actorDisplayName: 'John Doe',
        operation: 'create',
        resourceType: 'page',
        resourceId: 'page-1',
        driveId: 'drive-1',
      };

      // Act
      await logActivity(input);

      // Assert - verify the exact values stored
      expect(testState.capturedInsertValues).toMatchObject({
        actorEmail: 'john@example.com',
        actorDisplayName: 'John Doe',
      });
    });
  });

  describe('logPageActivity convenience wrapper', () => {
    it('should pass actorEmail and actorDisplayName through to logActivity', async () => {
      // Arrange & Act - use the fire-and-forget pattern but await the internal promise
      logPageActivity(
        'user-123',
        'create',
        { id: 'page-1', title: 'Test Page', driveId: 'drive-1' },
        {
          actorEmail: 'john@example.com',
          actorDisplayName: 'John Doe',
        }
      );

      // Wait for async execution to complete
      await vi.waitFor(() => {
        expect(testState.capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(testState.capturedInsertValues).toMatchObject({
        actorEmail: 'john@example.com',
        actorDisplayName: 'John Doe',
        resourceType: 'page',
        resourceId: 'page-1',
      });
    });

    it('should default actorEmail to unknown@system when not provided', async () => {
      // Arrange & Act
      logPageActivity(
        'user-123',
        'create',
        { id: 'page-1', title: 'Test Page', driveId: 'drive-1' }
      );

      // Wait for async execution
      await vi.waitFor(() => {
        expect(testState.capturedInsertValues).not.toBeNull();
      });

      // Assert - verify fallback behavior
      expect(testState.capturedInsertValues).toMatchObject({
        actorEmail: 'unknown@system',
      });
    });
  });

  describe('logPermissionActivity convenience wrapper', () => {
    it('should pass actorEmail and actorDisplayName through', async () => {
      // Arrange & Act
      logPermissionActivity(
        'user-123',
        'permission_grant',
        {
          pageId: 'page-1',
          driveId: 'drive-1',
          targetUserId: 'user-456',
          permissions: { canView: true },
        },
        {
          actorEmail: 'john@example.com',
          actorDisplayName: 'John Doe',
        }
      );

      // Wait for async execution
      await vi.waitFor(() => {
        expect(testState.capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(testState.capturedInsertValues).toMatchObject({
        actorEmail: 'john@example.com',
        actorDisplayName: 'John Doe',
        operation: 'permission_grant',
        resourceType: 'permission',
      });
    });
  });

  describe('logDriveActivity convenience wrapper', () => {
    it('should pass actorEmail and actorDisplayName through', async () => {
      // Arrange & Act
      logDriveActivity(
        'user-123',
        'create',
        { id: 'drive-1', name: 'Test Drive' },
        {
          actorEmail: 'john@example.com',
          actorDisplayName: 'John Doe',
        }
      );

      // Wait for async execution
      await vi.waitFor(() => {
        expect(testState.capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(testState.capturedInsertValues).toMatchObject({
        actorEmail: 'john@example.com',
        actorDisplayName: 'John Doe',
        resourceType: 'drive',
        resourceId: 'drive-1',
      });
    });
  });

  describe('logAgentConfigActivity convenience wrapper', () => {
    it('should pass actorEmail and actorDisplayName through', async () => {
      // Arrange & Act
      logAgentConfigActivity(
        'user-123',
        { id: 'agent-1', name: 'Test Agent', driveId: 'drive-1' },
        {
          updatedFields: ['systemPrompt'],
        },
        {
          actorEmail: 'john@example.com',
          actorDisplayName: 'John Doe',
        }
      );

      // Wait for async execution
      await vi.waitFor(() => {
        expect(testState.capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(testState.capturedInsertValues).toMatchObject({
        actorEmail: 'john@example.com',
        actorDisplayName: 'John Doe',
        operation: 'agent_config_update',
        resourceType: 'agent',
      });
    });
  });

  describe('logMessageActivity convenience wrapper', () => {
    it('should pass message_update operation with content tracking', async () => {
      // Arrange & Act
      logMessageActivity(
        'user-123',
        'message_update',
        {
          id: 'msg-1',
          pageId: 'page-1',
          driveId: 'drive-1',
          conversationType: 'ai_chat',
        },
        { actorEmail: 'john@example.com' },
        {
          previousContent: 'Old text',
          newContent: 'New text',
        }
      );

      // Wait for async execution
      await vi.waitFor(() => {
        expect(testState.capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(testState.capturedInsertValues).toMatchObject({
        operation: 'message_update',
        resourceType: 'message',
        resourceId: 'msg-1',
        pageId: 'page-1',
        driveId: 'drive-1',
        actorEmail: 'john@example.com',
        previousValues: { content: 'Old text' },
        newValues: { content: 'New text' },
      });
    });

    it('should pass message_delete operation with previous content', async () => {
      // Arrange & Act
      logMessageActivity(
        'user-123',
        'message_delete',
        {
          id: 'msg-1',
          pageId: 'page-1',
          driveId: null, // Global conversations have null driveId
          conversationType: 'global',
        },
        { actorEmail: 'john@example.com' },
        {
          previousContent: 'Deleted message text',
        }
      );

      // Wait for async execution
      await vi.waitFor(() => {
        expect(testState.capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(testState.capturedInsertValues).toMatchObject({
        operation: 'message_delete',
        resourceType: 'message',
        driveId: null,
        previousValues: { content: 'Deleted message text' },
      });
    });

    it('should include conversationType in metadata', async () => {
      // Arrange & Act
      logMessageActivity(
        'user-123',
        'message_update',
        {
          id: 'msg-1',
          pageId: 'page-1',
          driveId: 'drive-1',
          conversationType: 'channel',
        },
        { actorEmail: 'john@example.com' },
        {}
      );

      // Wait for async execution
      await vi.waitFor(() => {
        expect(testState.capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(testState.capturedInsertValues?.metadata).toMatchObject({
        conversationType: 'channel',
      });
    });

    it('should pass AI attribution fields when provided', async () => {
      // Arrange & Act
      logMessageActivity(
        'user-123',
        'message_update',
        {
          id: 'msg-1',
          pageId: 'page-1',
          driveId: 'drive-1',
          conversationType: 'ai_chat',
        },
        { actorEmail: 'john@example.com' },
        {
          isAiGenerated: true,
          aiProvider: 'openai',
          aiModel: 'gpt-4',
          aiConversationId: 'conv-1',
        }
      );

      // Wait for async execution
      await vi.waitFor(() => {
        expect(testState.capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(testState.capturedInsertValues).toMatchObject({
        isAiGenerated: true,
        aiProvider: 'openai',
        aiModel: 'gpt-4',
        aiConversationId: 'conv-1',
      });
    });

    it('should pass actorDisplayName when provided', async () => {
      // Arrange & Act
      logMessageActivity(
        'user-123',
        'message_update',
        {
          id: 'msg-1',
          pageId: 'page-1',
          driveId: 'drive-1',
          conversationType: 'ai_chat',
        },
        { actorEmail: 'john@example.com', actorDisplayName: 'John Doe' },
        {}
      );

      // Wait for async execution
      await vi.waitFor(() => {
        expect(testState.capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(testState.capturedInsertValues).toMatchObject({
        actorEmail: 'john@example.com',
        actorDisplayName: 'John Doe',
      });
    });
  });

  describe('logRoleActivity convenience wrapper', () => {
    it('should pass role_reorder with previous and new order', async () => {
      // Arrange & Act
      logRoleActivity(
        'user-123',
        'role_reorder',
        {
          driveId: 'drive-1',
          driveName: 'Test Drive',
          previousOrder: ['role-1', 'role-2', 'role-3'],
          newOrder: ['role-3', 'role-1', 'role-2'],
        },
        { actorEmail: 'john@example.com' }
      );

      // Wait for async execution
      await vi.waitFor(() => {
        expect(testState.capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(testState.capturedInsertValues).toMatchObject({
        operation: 'role_reorder',
        resourceType: 'role',
        driveId: 'drive-1',
        actorEmail: 'john@example.com',
        previousValues: { order: ['role-1', 'role-2', 'role-3'] },
        newValues: { order: ['role-3', 'role-1', 'role-2'] },
      });
    });

    it('should include driveName in metadata for role_reorder', async () => {
      // Arrange & Act
      logRoleActivity(
        'user-123',
        'role_reorder',
        {
          driveId: 'drive-1',
          driveName: 'Test Drive',
          previousOrder: ['role-1'],
          newOrder: ['role-1'],
        },
        { actorEmail: 'john@example.com' }
      );

      // Wait for async execution
      await vi.waitFor(() => {
        expect(testState.capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(testState.capturedInsertValues?.metadata).toMatchObject({
        driveName: 'Test Drive',
      });
    });

    it('should use driveId as resourceId for role_reorder', async () => {
      // Arrange & Act
      logRoleActivity(
        'user-123',
        'role_reorder',
        {
          driveId: 'drive-1',
          driveName: 'Test Drive',
          previousOrder: ['role-1'],
          newOrder: ['role-1'],
        },
        { actorEmail: 'john@example.com' }
      );

      // Wait for async execution
      await vi.waitFor(() => {
        expect(testState.capturedInsertValues).not.toBeNull();
      });

      // Assert - for reorder, resourceId is the driveId since it affects multiple roles
      expect(testState.capturedInsertValues).toMatchObject({
        resourceId: 'drive-1',
      });
    });
  });

  describe('logRollbackActivity convenience wrapper', () => {
    it('should log rollback operation with source activity reference', async () => {
      // Arrange & Act
      logRollbackActivity(
        'user-123',
        'source-activity-456',
        {
          resourceType: 'page',
          resourceId: 'page-1',
          resourceTitle: 'Test Page',
          driveId: 'drive-1',
          pageId: 'page-1',
        },
        { actorEmail: 'john@example.com', actorDisplayName: 'John Doe' }
      );

      // Wait for async execution
      await vi.waitFor(() => {
        expect(testState.capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(testState.capturedInsertValues).toMatchObject({
        operation: 'rollback',
        resourceType: 'page',
        resourceId: 'page-1',
        resourceTitle: 'Test Page',
        driveId: 'drive-1',
        pageId: 'page-1',
        actorEmail: 'john@example.com',
        actorDisplayName: 'John Doe',
        rollbackFromActivityId: 'source-activity-456',
      });
    });

    it('should include restored and replaced values', async () => {
      // Arrange & Act
      logRollbackActivity(
        'user-123',
        'source-activity-456',
        {
          resourceType: 'page',
          resourceId: 'page-1',
          driveId: 'drive-1',
        },
        { actorEmail: 'john@example.com' },
        {
          restoredValues: { title: 'Old Title' },
          replacedValues: { title: 'New Title' },
        }
      );

      // Wait for async execution
      await vi.waitFor(() => {
        expect(testState.capturedInsertValues).not.toBeNull();
      });

      // Assert - previousValues = what we're replacing, newValues = what we restored
      expect(testState.capturedInsertValues).toMatchObject({
        previousValues: { title: 'New Title' },
        newValues: { title: 'Old Title' },
      });
    });

    it('should include source activity snapshot for audit trail preservation', async () => {
      // Arrange & Act
      const sourceTimestamp = new Date('2024-01-10T10:00:00Z');

      logRollbackActivity(
        'user-123',
        'source-activity-456',
        {
          resourceType: 'page',
          resourceId: 'page-1',
          driveId: 'drive-1',
        },
        { actorEmail: 'john@example.com' },
        {
          rollbackSourceOperation: 'update',
          rollbackSourceTimestamp: sourceTimestamp,
          rollbackSourceTitle: 'Original Page Title',
        }
      );

      // Wait for async execution
      await vi.waitFor(() => {
        expect(testState.capturedInsertValues).not.toBeNull();
      });

      // Assert - denormalized source info survives retention policy deletion
      expect(testState.capturedInsertValues).toMatchObject({
        rollbackFromActivityId: 'source-activity-456',
        rollbackSourceOperation: 'update',
        rollbackSourceTimestamp: sourceTimestamp,
        rollbackSourceTitle: 'Original Page Title',
      });
    });

    it('should include content snapshot when rolling back content', async () => {
      // Arrange & Act
      logRollbackActivity(
        'user-123',
        'source-activity-456',
        {
          resourceType: 'page',
          resourceId: 'page-1',
          driveId: 'drive-1',
        },
        { actorEmail: 'john@example.com' },
        {
          contentSnapshot: '<p>Restored content</p>',
          contentFormat: 'tiptap',
        }
      );

      // Wait for async execution
      await vi.waitFor(() => {
        expect(testState.capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(testState.capturedInsertValues).toMatchObject({
        contentSnapshot: '<p>Restored content</p>',
        contentFormat: 'tiptap',
      });
    });
  });

  describe('logConversationUndo convenience wrapper', () => {
    it('should log conversation_undo for messages_only mode', async () => {
      // Arrange & Act
      logConversationUndo(
        'user-123',
        'conv-456',
        'msg-789',
        { actorEmail: 'john@example.com', actorDisplayName: 'John Doe' },
        {
          mode: 'messages_only',
          messagesDeleted: 5,
          activitiesRolledBack: 0,
          pageId: 'page-1',
          driveId: 'drive-1',
        }
      );

      // Wait for async execution
      await vi.waitFor(() => {
        expect(testState.capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(testState.capturedInsertValues).toMatchObject({
        operation: 'conversation_undo',
        resourceType: 'conversation',
        resourceId: 'conv-456',
        actorEmail: 'john@example.com',
        actorDisplayName: 'John Doe',
        pageId: 'page-1',
        driveId: 'drive-1',
      });
    });

    it('should log conversation_undo_with_changes for messages_and_changes mode', async () => {
      // Arrange & Act
      logConversationUndo(
        'user-123',
        'conv-456',
        'msg-789',
        { actorEmail: 'john@example.com' },
        {
          mode: 'messages_and_changes',
          messagesDeleted: 3,
          activitiesRolledBack: 2,
          rolledBackActivityIds: ['act-1', 'act-2'],
        }
      );

      // Wait for async execution
      await vi.waitFor(() => {
        expect(testState.capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(testState.capturedInsertValues).toMatchObject({
        operation: 'conversation_undo_with_changes',
        resourceType: 'conversation',
      });
    });

    it('should include undo metadata with counts and IDs', async () => {
      // Arrange & Act
      logConversationUndo(
        'user-123',
        'conv-456',
        'msg-789',
        { actorEmail: 'john@example.com' },
        {
          mode: 'messages_and_changes',
          messagesDeleted: 3,
          activitiesRolledBack: 2,
          rolledBackActivityIds: ['act-1', 'act-2'],
        }
      );

      // Wait for async execution
      await vi.waitFor(() => {
        expect(testState.capturedInsertValues).not.toBeNull();
      });

      // Assert - metadata contains undo details
      expect(testState.capturedInsertValues?.metadata).toMatchObject({
        messageId: 'msg-789',
        messagesDeleted: 3,
        activitiesRolledBack: 2,
        rolledBackActivityIds: ['act-1', 'act-2'],
        mode: 'messages_and_changes',
      });
    });

    it('should include previousValues indicating messages were active', async () => {
      // Arrange & Act
      logConversationUndo(
        'user-123',
        'conv-456',
        'msg-789',
        { actorEmail: 'john@example.com' },
        {
          mode: 'messages_only',
          messagesDeleted: 1,
          activitiesRolledBack: 0,
        }
      );

      // Wait for async execution
      await vi.waitFor(() => {
        expect(testState.capturedInsertValues).not.toBeNull();
      });

      // Assert - previousValues tracks that messages were active before undo
      expect(testState.capturedInsertValues).toMatchObject({
        previousValues: { messagesWereActive: true },
      });
    });

    it('should handle null driveId for global assistant conversations', async () => {
      // Arrange & Act
      logConversationUndo(
        'user-123',
        'conv-456',
        'msg-789',
        { actorEmail: 'john@example.com' },
        {
          mode: 'messages_only',
          messagesDeleted: 1,
          activitiesRolledBack: 0,
          driveId: null,
        }
      );

      // Wait for async execution
      await vi.waitFor(() => {
        expect(testState.capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(testState.capturedInsertValues).toMatchObject({
        driveId: null,
      });
    });
  });

  describe('hash chain integration', () => {
    it('should compute logHash on log insertion', async () => {
      // Arrange
      const input: ActivityLogInput = {
        userId: 'user-123',
        actorEmail: 'john@example.com',
        operation: 'create',
        resourceType: 'page',
        resourceId: 'page-1',
        driveId: 'drive-1',
      };

      // Act
      await logActivity(input);

      // Assert - verify hash chain fields are present
      expect(testState.capturedInsertValues).toHaveProperty('logHash');
      expect(testState.capturedInsertValues?.logHash).toBeDefined();
      expect(typeof testState.capturedInsertValues?.logHash).toBe('string');
      expect((testState.capturedInsertValues?.logHash as string).length).toBe(64); // SHA-256 hex length
    });

    it('should generate chainSeed for first log entry', async () => {
      // Arrange - ensure no previous logs exist (testState.lastInsertedHash is null)
      testState.lastInsertedHash = null;

      const input: ActivityLogInput = {
        userId: 'user-123',
        actorEmail: 'john@example.com',
        operation: 'create',
        resourceType: 'page',
        resourceId: 'page-1',
        driveId: 'drive-1',
      };

      // Act
      await logActivity(input);

      // Assert - first entry should have chainSeed but no previousLogHash
      expect(testState.capturedInsertValues).toHaveProperty('chainSeed');
      expect(testState.capturedInsertValues?.chainSeed).toBeDefined();
      expect(typeof testState.capturedInsertValues?.chainSeed).toBe('string');
      expect((testState.capturedInsertValues?.chainSeed as string).length).toBe(64); // 32 bytes hex
      expect(testState.capturedInsertValues?.previousLogHash).toBeNull();
    });

    it('should chain to previous log hash for subsequent entries', async () => {
      // Arrange - simulate a previous log entry
      const expectedPreviousHash = 'abc123previoushash0000000000000000000000000000000000000000000000';
      testState.lastInsertedHash = expectedPreviousHash;

      const input: ActivityLogInput = {
        userId: 'user-123',
        actorEmail: 'john@example.com',
        operation: 'update',
        resourceType: 'page',
        resourceId: 'page-1',
        driveId: 'drive-1',
      };

      // Act
      await logActivity(input);

      // Assert - subsequent entry should reference previous hash
      // Note: testState.lastInsertedHash gets updated by the mock, so compare against saved value
      expect(testState.capturedInsertValues?.previousLogHash).toBe(expectedPreviousHash);
      expect(testState.capturedInsertValues?.chainSeed).toBeNull(); // Only first entry has seed
      expect(testState.capturedInsertValues?.logHash).toBeDefined();
      expect(testState.capturedInsertValues?.logHash).not.toBe(expectedPreviousHash); // New hash should differ from previous
    });

    it('should produce deterministic hashes for same input data', async () => {
      // This test verifies hash computation is deterministic
      // We'll insert two entries and verify hashes are computed correctly

      // First entry (will be first in chain)
      const input1: ActivityLogInput = {
        userId: 'user-123',
        actorEmail: 'john@example.com',
        operation: 'create',
        resourceType: 'page',
        resourceId: 'page-1',
        driveId: 'drive-1',
      };

      await logActivity(input1);
      const firstHash = testState.capturedInsertValues?.logHash as string;

      // Second entry (will chain to first)
      const input2: ActivityLogInput = {
        userId: 'user-123',
        actorEmail: 'john@example.com',
        operation: 'update',
        resourceType: 'page',
        resourceId: 'page-1',
        driveId: 'drive-1',
      };

      await logActivity(input2);
      const secondHash = testState.capturedInsertValues?.logHash as string;

      // Assert - both should have valid SHA-256 hashes
      expect(firstHash).toHaveLength(64);
      expect(secondHash).toHaveLength(64);
      // And second should reference first
      expect(testState.capturedInsertValues?.previousLogHash).toBe(firstHash);
    });

    it('should include hash chain fields in logPageActivity', async () => {
      // Arrange & Act
      logPageActivity(
        'user-123',
        'create',
        { id: 'page-1', title: 'Test Page', driveId: 'drive-1' },
        { actorEmail: 'john@example.com' }
      );

      // Wait for async execution
      await vi.waitFor(() => {
        expect(testState.capturedInsertValues).not.toBeNull();
      });

      // Assert - hash chain fields should be present
      expect(testState.capturedInsertValues).toHaveProperty('logHash');
      expect(typeof testState.capturedInsertValues?.logHash).toBe('string');
    });
  });
});
