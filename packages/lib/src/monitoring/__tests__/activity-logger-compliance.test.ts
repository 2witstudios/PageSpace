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
});
