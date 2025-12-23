/**
 * Activity Logger Compliance Tests
 *
 * Tests for actor snapshot fields in activity logger:
 * - actorEmail required in ActivityLogInput
 * - actorDisplayName optional
 * - Convenience wrappers pass actor info through
 *
 * @scaffold - characterizing current behavior with ORM mock.
 * The activity-logger itself is the seam; these tests verify its contract.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the values passed to the database insert
let capturedInsertValues: Record<string, unknown> | null = null;

vi.mock('@pagespace/db', () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        capturedInsertValues = values;
        return Promise.resolve(undefined);
      }),
    }),
  },
  activityLogs: { id: 'id' },
}));

import { db } from '@pagespace/db';
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

const mockDb = vi.mocked(db);

describe('activity logger compliance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedInsertValues = null;
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
      expect(capturedInsertValues).toMatchObject({
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
      expect(capturedInsertValues).toMatchObject({
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
      expect(capturedInsertValues).toMatchObject({
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
        expect(capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(capturedInsertValues).toMatchObject({
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
        expect(capturedInsertValues).not.toBeNull();
      });

      // Assert - verify fallback behavior
      expect(capturedInsertValues).toMatchObject({
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
        expect(capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(capturedInsertValues).toMatchObject({
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
        expect(capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(capturedInsertValues).toMatchObject({
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
        expect(capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(capturedInsertValues).toMatchObject({
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
        expect(capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(capturedInsertValues).toMatchObject({
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
        expect(capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(capturedInsertValues).toMatchObject({
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
        expect(capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(capturedInsertValues?.metadata).toMatchObject({
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
        expect(capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(capturedInsertValues).toMatchObject({
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
        expect(capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(capturedInsertValues).toMatchObject({
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
        expect(capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(capturedInsertValues).toMatchObject({
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
        expect(capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(capturedInsertValues?.metadata).toMatchObject({
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
        expect(capturedInsertValues).not.toBeNull();
      });

      // Assert - for reorder, resourceId is the driveId since it affects multiple roles
      expect(capturedInsertValues).toMatchObject({
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
        expect(capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(capturedInsertValues).toMatchObject({
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
        expect(capturedInsertValues).not.toBeNull();
      });

      // Assert - previousValues = what we're replacing, newValues = what we restored
      expect(capturedInsertValues).toMatchObject({
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
        expect(capturedInsertValues).not.toBeNull();
      });

      // Assert - denormalized source info survives retention policy deletion
      expect(capturedInsertValues).toMatchObject({
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
        expect(capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(capturedInsertValues).toMatchObject({
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
        expect(capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(capturedInsertValues).toMatchObject({
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
        expect(capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(capturedInsertValues).toMatchObject({
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
        expect(capturedInsertValues).not.toBeNull();
      });

      // Assert - metadata contains undo details
      expect(capturedInsertValues?.metadata).toMatchObject({
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
        expect(capturedInsertValues).not.toBeNull();
      });

      // Assert - previousValues tracks that messages were active before undo
      expect(capturedInsertValues).toMatchObject({
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
        expect(capturedInsertValues).not.toBeNull();
      });

      // Assert
      expect(capturedInsertValues).toMatchObject({
        driveId: null,
      });
    });
  });
});
