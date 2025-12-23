/**
 * Rollback Permission Checks
 *
 * Determines whether a user can rollback (restore) a specific activity log entry.
 * Follows RBAC principle: if you can edit something, you can rollback changes to it.
 */

import { canUserEditPage, isDriveOwnerOrAdmin } from './permissions';
import type { ActivityResourceType } from '../monitoring/activity-logger';

/**
 * Context in which the rollback is being requested.
 * This affects which permission rules apply.
 */
export type RollbackContext =
  | 'page'           // Viewing a specific page's version history
  | 'drive'          // Drive admin viewing drive-wide activity
  | 'ai_tool'        // Rolling back AI-generated changes from chat
  | 'user_dashboard'; // User viewing their own activity across all drives

/**
 * Activity log data needed for permission checks
 */
export interface ActivityForPermissionCheck {
  id: string;
  userId: string | null;
  resourceType: ActivityResourceType;
  resourceId: string;
  driveId: string | null;
  pageId: string | null;
  isAiGenerated: boolean;
  operation: string;
}

/**
 * Result of a rollback permission check
 */
export interface RollbackPermissionResult {
  canRollback: boolean;
  reason?: string;
}

/**
 * Check if a user can rollback a specific activity log entry.
 *
 * Permission rules by context:
 * - page: Anyone with edit permission can rollback changes to that page
 * - drive: Drive owner/admin can rollback anyone's changes in the drive
 * - ai_tool: Only the user's own AI-generated changes
 * - user_dashboard: User can rollback all their own changes
 */
export async function canUserRollback(
  userId: string,
  activity: ActivityForPermissionCheck,
  context: RollbackContext
): Promise<RollbackPermissionResult> {
  // Can't rollback operations that don't have previousValues to restore
  const nonRollbackableOperations = ['signup', 'login', 'logout'];
  if (nonRollbackableOperations.includes(activity.operation)) {
    return {
      canRollback: false,
      reason: `Cannot rollback '${activity.operation}' operations`,
    };
  }

  // Can't rollback if already a rollback operation (would create infinite chain)
  if (activity.operation === 'rollback') {
    return {
      canRollback: false,
      reason: 'Cannot rollback a rollback operation',
    };
  }

  switch (context) {
    case 'ai_tool': {
      // Only user's own AI-generated changes
      if (activity.userId !== userId) {
        return {
          canRollback: false,
          reason: 'Can only rollback your own changes in AI chat context',
        };
      }
      if (!activity.isAiGenerated) {
        return {
          canRollback: false,
          reason: 'Only AI-generated changes can be rolled back in this context',
        };
      }
      return { canRollback: true };
    }

    case 'drive': {
      // Drive admin can rollback anyone's changes in the drive
      if (!activity.driveId) {
        return {
          canRollback: false,
          reason: 'Activity is not associated with a drive',
        };
      }
      const isDriveAdmin = await isDriveOwnerOrAdmin(userId, activity.driveId);
      if (!isDriveAdmin) {
        return {
          canRollback: false,
          reason: 'Only drive owners and admins can rollback changes in drive context',
        };
      }
      return { canRollback: true };
    }

    case 'user_dashboard': {
      // User can rollback all their own changes
      if (activity.userId !== userId) {
        return {
          canRollback: false,
          reason: 'Can only rollback your own changes from the dashboard',
        };
      }
      return { canRollback: true };
    }

    case 'page': {
      // Anyone with edit permission can rollback changes to that page
      if (!activity.pageId) {
        return {
          canRollback: false,
          reason: 'Activity is not associated with a page',
        };
      }
      const canEdit = await canUserEditPage(userId, activity.pageId);
      if (!canEdit) {
        return {
          canRollback: false,
          reason: 'You need edit permission to rollback changes to this page',
        };
      }
      return { canRollback: true };
    }

    default: {
      return {
        canRollback: false,
        reason: 'Unknown rollback context',
      };
    }
  }
}

/**
 * Check if a resource type supports rollback operations
 */
export function isRollbackableResourceType(resourceType: ActivityResourceType): boolean {
  const rollbackableTypes: ActivityResourceType[] = [
    'page',
    'drive',
    'permission',
    'agent',
    'member',
    'role',
    'message',
  ];
  return rollbackableTypes.includes(resourceType);
}

/**
 * Check if an operation type supports rollback
 */
export function isRollbackableOperation(operation: string): boolean {
  const rollbackableOperations = [
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
  return rollbackableOperations.includes(operation);
}

/**
 * Check if an activity is structurally eligible for rollback.
 * This checks the operation type and whether the activity has data to restore from.
 * Note: This does NOT check user permissions - use canUserRollback() for that.
 */
export function isActivityEligibleForRollback(activity: {
  operation: string;
  previousValues: unknown | null;
  contentSnapshot: string | null;
}): boolean {
  return (
    isRollbackableOperation(activity.operation) &&
    (activity.previousValues !== null || activity.contentSnapshot !== null)
  );
}
