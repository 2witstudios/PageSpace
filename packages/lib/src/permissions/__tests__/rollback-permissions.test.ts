/**
 * Contract tests for rollback-permissions.ts
 *
 * Tests for:
 * - Pure functions: isRollbackableOperation, isRollbackableResourceType, isActivityEligibleForRollback
 * - Permission logic: canUserRollback with various contexts
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import {
  canUserRollback,
  isRollbackableOperation,
  isRollbackableResourceType,
  isActivityEligibleForRollback,
  type RollbackContext,
  type ActivityForPermissionCheck,
} from '../rollback-permissions';

// Mock the permission functions at the boundary
vi.mock('../permissions', () => ({
  canUserEditPage: vi.fn(),
  isDriveOwnerOrAdmin: vi.fn(),
}));

import { canUserEditPage, isDriveOwnerOrAdmin } from '../permissions';

// Test fixtures
const mockUserId = 'user_123';
const mockOtherUserId = 'user_456';
const mockPageId = 'page_123';
const mockDriveId = 'drive_123';

const createActivity = (overrides: Partial<ActivityForPermissionCheck> = {}): ActivityForPermissionCheck => ({
  id: 'activity_123',
  userId: mockUserId,
  resourceType: 'page',
  resourceId: mockPageId,
  driveId: mockDriveId,
  pageId: mockPageId,
  isAiGenerated: false,
  operation: 'update',
  ...overrides,
});

describe('rollback-permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================
  // PURE FUNCTION TESTS (no mocking needed)
  // ============================================

  describe('isRollbackableOperation', () => {
    describe('rollbackable operations', () => {
      const rollbackableOps = [
        'create',
        'update',
        'delete',
        'trash',
        'move',
        'reorder',
        'permission_grant',
        'permission_update',
        'permission_revoke',
        'agent_config_update',
        'member_add',
        'member_remove',
        'member_role_change',
        'role_reorder',
        'message_update',
        'message_delete',
        'ownership_transfer',
      ];

      it.each(rollbackableOps)('returns true for %s operation', (operation) => {
        expect(isRollbackableOperation(operation)).toBe(true);
      });
    });

    describe('non-rollbackable operations', () => {
      const nonRollbackableOps = [
        'signup',
        'login',
        'logout',
        'password_change',
        'email_change',
        'token_create',
        'token_revoke',
        'upload',
        'convert',
        'account_delete',
        'profile_update',
        'avatar_update',
        'rollback', // Cannot rollback a rollback
        'conversation_undo',
        'conversation_undo_with_changes',
        'restore',
      ];

      it.each(nonRollbackableOps)('returns false for %s operation', (operation) => {
        expect(isRollbackableOperation(operation)).toBe(false);
      });
    });

    it('returns false for unknown operations', () => {
      expect(isRollbackableOperation('unknown_op')).toBe(false);
    });
  });

  describe('isRollbackableResourceType', () => {
    describe('rollbackable resource types', () => {
      const rollbackableTypes = ['page', 'drive', 'permission', 'agent', 'member', 'role', 'message'];

      it.each(rollbackableTypes)('returns true for %s resource type', (type) => {
        expect(isRollbackableResourceType(type as any)).toBe(true);
      });
    });

    describe('non-rollbackable resource types', () => {
      const nonRollbackableTypes = ['user', 'file', 'token', 'device', 'conversation'];

      it.each(nonRollbackableTypes)('returns false for %s resource type', (type) => {
        expect(isRollbackableResourceType(type as any)).toBe(false);
      });
    });
  });

  describe('isActivityEligibleForRollback', () => {
    it('returns true when operation is rollbackable and previousValues exists', () => {
      const activity = {
        operation: 'update',
        previousValues: { title: 'Old Title' },
        contentSnapshot: null,
      };

      expect(isActivityEligibleForRollback(activity)).toBe(true);
    });

    it('returns true when operation is rollbackable and contentSnapshot exists', () => {
      const activity = {
        operation: 'update',
        previousValues: null,
        contentSnapshot: '<p>Old content</p>',
      };

      expect(isActivityEligibleForRollback(activity)).toBe(true);
    });

    it('returns true when both previousValues and contentSnapshot exist', () => {
      const activity = {
        operation: 'update',
        previousValues: { title: 'Old Title' },
        contentSnapshot: '<p>Old content</p>',
      };

      expect(isActivityEligibleForRollback(activity)).toBe(true);
    });

    it('returns false when operation is not rollbackable', () => {
      const activity = {
        operation: 'signup',
        previousValues: { title: 'Title' },
        contentSnapshot: null,
      };

      expect(isActivityEligibleForRollback(activity)).toBe(false);
    });

    it('returns false when no previousValues or contentSnapshot', () => {
      const activity = {
        operation: 'update',
        previousValues: null,
        contentSnapshot: null,
      };

      expect(isActivityEligibleForRollback(activity)).toBe(false);
    });

    it('returns false for rollback operations (prevents infinite chain)', () => {
      const activity = {
        operation: 'rollback',
        previousValues: { title: 'Old Title' },
        contentSnapshot: null,
      };

      expect(isActivityEligibleForRollback(activity)).toBe(false);
    });
  });

  // ============================================
  // PERMISSION CHECK TESTS (mocking at seams)
  // ============================================

  describe('canUserRollback', () => {
    describe('non-rollbackable operations rejection', () => {
      const nonRollbackableOps = ['signup', 'login', 'logout'];

      it.each(nonRollbackableOps)(
        'denies rollback for %s operation regardless of context',
        async (operation) => {
          const activity = createActivity({ operation });

          const result = await canUserRollback(mockUserId, activity, 'page');

          expect(result.canRollback).toBe(false);
          expect(result.reason).toContain(`Cannot rollback '${operation}'`);
        }
      );
    });

    it('denies rollback of rollback operations (prevents infinite chain)', async () => {
      const activity = createActivity({ operation: 'rollback' });

      const result = await canUserRollback(mockUserId, activity, 'page');

      expect(result.canRollback).toBe(false);
      expect(result.reason).toBe('Cannot rollback a rollback operation');
    });

    describe('ai_tool context', () => {
      const context: RollbackContext = 'ai_tool';

      it('allows rollback of own AI-generated changes', async () => {
        const activity = createActivity({
          userId: mockUserId,
          isAiGenerated: true,
          operation: 'update',
        });

        const result = await canUserRollback(mockUserId, activity, context);

        expect(result.canRollback).toBe(true);
        expect(result.reason).toBeUndefined();
      });

      it('denies rollback of other users AI-generated changes', async () => {
        const activity = createActivity({
          userId: mockOtherUserId,
          isAiGenerated: true,
          operation: 'update',
        });

        const result = await canUserRollback(mockUserId, activity, context);

        expect(result.canRollback).toBe(false);
        expect(result.reason).toContain('only rollback your own changes');
      });

      it('denies rollback of non-AI changes in AI context', async () => {
        const activity = createActivity({
          userId: mockUserId,
          isAiGenerated: false,
          operation: 'update',
        });

        const result = await canUserRollback(mockUserId, activity, context);

        expect(result.canRollback).toBe(false);
        expect(result.reason).toContain('Only AI-generated changes');
      });
    });

    describe('page context', () => {
      const context: RollbackContext = 'page';

      it('allows rollback when user has edit permission', async () => {
        (canUserEditPage as Mock).mockResolvedValue(true);
        const activity = createActivity({ operation: 'update' });

        const result = await canUserRollback(mockUserId, activity, context);

        expect(result.canRollback).toBe(true);
        expect(canUserEditPage).toHaveBeenCalledWith(mockUserId, mockPageId);
      });

      it('denies rollback when user lacks edit permission', async () => {
        (canUserEditPage as Mock).mockResolvedValue(false);
        const activity = createActivity({ operation: 'update' });

        const result = await canUserRollback(mockUserId, activity, context);

        expect(result.canRollback).toBe(false);
        expect(result.reason).toContain('need edit permission');
      });

      it('denies rollback when activity has no pageId', async () => {
        const activity = createActivity({ pageId: null });

        const result = await canUserRollback(mockUserId, activity, context);

        expect(result.canRollback).toBe(false);
        expect(result.reason).toContain('not associated with a page');
      });
    });

    describe('drive context', () => {
      const context: RollbackContext = 'drive';

      it('allows drive admin to rollback any change in drive', async () => {
        (isDriveOwnerOrAdmin as Mock).mockResolvedValue(true);
        const activity = createActivity({
          userId: mockOtherUserId, // Different user's activity
          operation: 'update',
        });

        const result = await canUserRollback(mockUserId, activity, context);

        expect(result.canRollback).toBe(true);
        expect(isDriveOwnerOrAdmin).toHaveBeenCalledWith(mockUserId, mockDriveId);
      });

      it('denies rollback for non-admin users', async () => {
        (isDriveOwnerOrAdmin as Mock).mockResolvedValue(false);
        const activity = createActivity({ operation: 'update' });

        const result = await canUserRollback(mockUserId, activity, context);

        expect(result.canRollback).toBe(false);
        expect(result.reason).toContain('owners and admins');
      });

      it('denies rollback when activity has no driveId', async () => {
        const activity = createActivity({ driveId: null });

        const result = await canUserRollback(mockUserId, activity, context);

        expect(result.canRollback).toBe(false);
        expect(result.reason).toContain('not associated with a drive');
      });
    });

    describe('user_dashboard context', () => {
      const context: RollbackContext = 'user_dashboard';

      it('allows user to rollback their own changes', async () => {
        const activity = createActivity({
          userId: mockUserId,
          operation: 'update',
        });

        const result = await canUserRollback(mockUserId, activity, context);

        expect(result.canRollback).toBe(true);
      });

      it('denies rollback of other users changes', async () => {
        const activity = createActivity({
          userId: mockOtherUserId,
          operation: 'update',
        });

        const result = await canUserRollback(mockUserId, activity, context);

        expect(result.canRollback).toBe(false);
        expect(result.reason).toContain('only rollback your own changes');
      });
    });

    describe('unknown context', () => {
      it('denies rollback for unknown context', async () => {
        const activity = createActivity({ operation: 'update' });

        const result = await canUserRollback(mockUserId, activity, 'unknown' as RollbackContext);

        expect(result.canRollback).toBe(false);
        expect(result.reason).toBe('Unknown rollback context');
      });
    });
  });
});
