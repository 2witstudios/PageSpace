/**
 * Rollback Service
 *
 * Handles version history rollback operations for PageSpace.
 * Allows users to restore resources to previous states based on activity logs.
 */

import { db, activityLogs, pages, drives, driveMembers, driveRoles, pagePermissions, users, chatMessages, eq, and, desc, gte, lte, count } from '@pagespace/db';
import {
  canUserRollback,
  isRollbackableOperation,
  type RollbackContext,
} from '@pagespace/lib/permissions';

// Re-export RollbackContext for consumers
export type { RollbackContext };
import {
  logRollbackActivity,
  getActorInfo,
  type ActivityResourceType,
  type ActivityOperation,
} from '@pagespace/lib/monitoring';
import { loggers } from '@pagespace/lib/server';

/**
 * Valid activity operations for filtering
 */
const VALID_OPERATIONS = [
  'create', 'update', 'delete', 'restore', 'reorder',
  'permission_grant', 'permission_update', 'permission_revoke',
  'trash', 'move', 'agent_config_update',
  'member_add', 'member_remove', 'member_role_change',
  'login', 'logout', 'signup', 'password_change', 'email_change',
  'token_create', 'token_revoke', 'upload', 'convert',
  'account_delete', 'profile_update', 'avatar_update',
  'message_update', 'message_delete', 'role_reorder', 'ownership_transfer',
  'rollback', 'conversation_undo', 'conversation_undo_with_changes',
] as const;

/**
 * Check if a string is a valid activity operation
 */
function isValidOperation(operation: string): boolean {
  return VALID_OPERATIONS.includes(operation as typeof VALID_OPERATIONS[number]);
}

/**
 * Activity log with full details for rollback
 */
export interface ActivityLogForRollback {
  id: string;
  timestamp: Date;
  userId: string | null;
  actorEmail: string;
  actorDisplayName: string | null;
  operation: string;
  resourceType: ActivityResourceType;
  resourceId: string;
  resourceTitle: string | null;
  driveId: string | null;
  pageId: string | null;
  isAiGenerated: boolean;
  aiProvider: string | null;
  aiModel: string | null;
  contentSnapshot: string | null;
  updatedFields: string[] | null;
  previousValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Result of a rollback preview
 */
export interface RollbackPreview {
  activity: ActivityLogForRollback | null;
  canRollback: boolean;
  reason?: string;
  currentValues: Record<string, unknown> | null;
  rollbackToValues: Record<string, unknown> | null;
  warnings: string[];
  affectedResources: { type: string; id: string; title: string }[];
}

/**
 * Result of executing a rollback
 */
export interface RollbackResult {
  success: boolean;
  rollbackActivityId?: string;
  restoredValues?: Record<string, unknown>;
  message: string;
  warnings: string[];
}

/**
 * Options for fetching version history
 */
export interface VersionHistoryOptions {
  limit?: number;
  offset?: number;
  startDate?: Date;
  endDate?: Date;
  actorId?: string;
  operation?: string;
  includeAiOnly?: boolean;
  resourceType?: string;
}

/**
 * Fetch a single activity log by ID
 */
export async function getActivityById(
  activityId: string
): Promise<ActivityLogForRollback | null> {
  try {
    const result = await db
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.id, activityId))
      .limit(1);

    if (result.length === 0) {
      return null;
    }

    const activity = result[0];
    return {
      id: activity.id,
      timestamp: activity.timestamp,
      userId: activity.userId,
      actorEmail: activity.actorEmail,
      actorDisplayName: activity.actorDisplayName,
      operation: activity.operation,
      resourceType: activity.resourceType as ActivityResourceType,
      resourceId: activity.resourceId,
      resourceTitle: activity.resourceTitle,
      driveId: activity.driveId,
      pageId: activity.pageId,
      isAiGenerated: activity.isAiGenerated,
      aiProvider: activity.aiProvider,
      aiModel: activity.aiModel,
      contentSnapshot: activity.contentSnapshot,
      updatedFields: activity.updatedFields as string[] | null,
      previousValues: activity.previousValues as Record<string, unknown> | null,
      newValues: activity.newValues as Record<string, unknown> | null,
      metadata: activity.metadata as Record<string, unknown> | null,
    };
  } catch (error) {
    loggers.api.error('[RollbackService] Error fetching activity', {
      activityId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Preview what a rollback would do
 */
export async function previewRollback(
  activityId: string,
  userId: string,
  context: RollbackContext
): Promise<RollbackPreview> {
  const activity = await getActivityById(activityId);

  if (!activity) {
    return {
      activity: null,
      canRollback: false,
      reason: 'Activity not found',
      currentValues: null,
      rollbackToValues: null,
      warnings: [],
      affectedResources: [],
    };
  }

  // Check if operation is rollbackable
  if (!isRollbackableOperation(activity.operation)) {
    return {
      activity,
      canRollback: false,
      reason: `Cannot rollback '${activity.operation}' operations`,
      currentValues: null,
      rollbackToValues: null,
      warnings: [],
      affectedResources: [],
    };
  }

  // Check if previousValues exist
  if (!activity.previousValues && !activity.contentSnapshot) {
    return {
      activity,
      canRollback: false,
      reason: 'No previous state available to restore',
      currentValues: null,
      rollbackToValues: null,
      warnings: [],
      affectedResources: [],
    };
  }

  // Check permissions
  const permissionCheck = await canUserRollback(userId, activity, context);
  if (!permissionCheck.canRollback) {
    return {
      activity,
      canRollback: false,
      reason: permissionCheck.reason,
      currentValues: null,
      rollbackToValues: null,
      warnings: [],
      affectedResources: [],
    };
  }

  // Get current state and check for conflicts
  const warnings: string[] = [];
  let currentValues: Record<string, unknown> | null = null;

  if (activity.resourceType === 'page' && activity.pageId) {
    const currentPage = await db
      .select()
      .from(pages)
      .where(eq(pages.id, activity.pageId))
      .limit(1);

    if (currentPage.length === 0) {
      return {
        activity,
        canRollback: false,
        reason: 'Resource no longer exists',
        currentValues: null,
        rollbackToValues: null,
        warnings: [],
        affectedResources: [],
      };
    }

    currentValues = {
      title: currentPage[0].title,
      content: currentPage[0].content,
      parentId: currentPage[0].parentId,
      position: currentPage[0].position,
    };

    // Check if state has changed since the activity
    if (activity.newValues) {
      const newValuesMatch = Object.entries(activity.newValues).every(
        ([key, value]) => {
          const currentVal = currentValues?.[key];
          return JSON.stringify(currentVal) === JSON.stringify(value);
        }
      );

      if (!newValuesMatch) {
        warnings.push(
          'This resource has been modified since this change. Rollback will overwrite those modifications.'
        );
      }
    }
  }

  return {
    activity,
    canRollback: true,
    currentValues,
    rollbackToValues: activity.previousValues,
    warnings,
    affectedResources: [
      {
        type: activity.resourceType,
        id: activity.resourceId,
        title: activity.resourceTitle || 'Untitled',
      },
    ],
  };
}

/**
 * Execute a rollback operation
 * @param tx - Optional transaction to use for all database operations (for atomicity)
 */
export async function executeRollback(
  activityId: string,
  userId: string,
  context: RollbackContext,
  tx?: typeof db
): Promise<RollbackResult> {
  const preview = await previewRollback(activityId, userId, context);

  if (!preview.canRollback || !preview.activity) {
    return {
      success: false,
      message: preview.reason || 'Cannot rollback this activity',
      warnings: [],
    };
  }

  const activity = preview.activity;
  const warnings: string[] = [...preview.warnings];
  const database = tx ?? db;

  try {
    // Get actor info for logging
    const actorInfo = await getActorInfo(userId);

    // Execute rollback based on resource type
    let restoredValues: Record<string, unknown> = {};

    switch (activity.resourceType) {
      case 'page':
        restoredValues = await rollbackPageChange(activity, preview.currentValues, database);
        break;

      case 'drive':
        restoredValues = await rollbackDriveChange(activity, preview.currentValues, database);
        break;

      case 'permission':
        restoredValues = await rollbackPermissionChange(activity, database);
        break;

      case 'agent':
        restoredValues = await rollbackAgentConfigChange(activity, preview.currentValues, database);
        break;

      case 'member':
        restoredValues = await rollbackMemberChange(activity, database);
        break;

      case 'role':
        restoredValues = await rollbackRoleChange(activity, database);
        break;

      case 'message':
        restoredValues = await rollbackMessageChange(activity, database);
        break;

      default:
        return {
          success: false,
          message: `Rollback not supported for resource type: ${activity.resourceType}`,
          warnings,
        };
    }

    // Log the rollback activity with source snapshot for audit trail preservation
    logRollbackActivity(
      userId,
      activityId,
      {
        resourceType: activity.resourceType,
        resourceId: activity.resourceId,
        resourceTitle: activity.resourceTitle ?? undefined,
        driveId: activity.driveId,
        pageId: activity.pageId ?? undefined,
      },
      actorInfo,
      {
        restoredValues,
        replacedValues: preview.currentValues ?? undefined,
        contentSnapshot: activity.contentSnapshot ?? undefined,
        // Source activity snapshot - survives retention policy deletion
        rollbackSourceOperation: activity.operation as ActivityOperation,
        rollbackSourceTimestamp: activity.timestamp,
        rollbackSourceTitle: activity.resourceTitle ?? undefined,
      }
    );

    return {
      success: true,
      restoredValues,
      message: 'Successfully restored to previous state',
      warnings,
    };
  } catch (error) {
    loggers.api.error('[RollbackService] Error executing rollback', {
      activityId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      message: error instanceof Error ? error.message : 'Failed to execute rollback',
      warnings,
    };
  }
}

/**
 * Rollback a page change
 */
async function rollbackPageChange(
  activity: ActivityLogForRollback,
  _currentValues: Record<string, unknown> | null,
  database: typeof db
): Promise<Record<string, unknown>> {
  if (!activity.pageId) {
    throw new Error('Page ID not found in activity');
  }

  const previousValues = activity.previousValues || {};
  const updateData: Record<string, unknown> = {};

  // Restore fields that were changed
  if (activity.updatedFields) {
    for (const field of activity.updatedFields) {
      if (field in previousValues) {
        updateData[field] = previousValues[field];
      }
    }
  } else if (Object.keys(previousValues).length > 0) {
    // If no updatedFields, restore all previousValues
    Object.assign(updateData, previousValues);
  }

  // If we have a content snapshot and content was changed, use it
  if (activity.contentSnapshot && activity.operation === 'update') {
    updateData.content = activity.contentSnapshot;
  }

  if (Object.keys(updateData).length === 0) {
    throw new Error('No values to restore');
  }

  // Update the page
  await database
    .update(pages)
    .set({
      ...updateData,
      updatedAt: new Date(),
    })
    .where(eq(pages.id, activity.pageId));

  return updateData;
}

/**
 * Rollback a drive change
 */
async function rollbackDriveChange(
  activity: ActivityLogForRollback,
  _currentValues: Record<string, unknown> | null,
  database: typeof db
): Promise<Record<string, unknown>> {
  if (!activity.driveId) {
    throw new Error('Drive ID not found in activity');
  }

  const previousValues = activity.previousValues || {};
  const updateData: Record<string, unknown> = {};

  // Restore fields that were changed
  if (activity.updatedFields) {
    for (const field of activity.updatedFields) {
      if (field in previousValues) {
        updateData[field] = previousValues[field];
      }
    }
  } else if (Object.keys(previousValues).length > 0) {
    Object.assign(updateData, previousValues);
  }

  if (Object.keys(updateData).length === 0) {
    throw new Error('No values to restore');
  }

  // Update the drive
  await database
    .update(drives)
    .set({
      ...updateData,
      updatedAt: new Date(),
    })
    .where(eq(drives.id, activity.driveId));

  return updateData;
}

/**
 * Rollback a permission change
 */
async function rollbackPermissionChange(
  activity: ActivityLogForRollback,
  database: typeof db
): Promise<Record<string, unknown>> {
  const metadata = activity.metadata as { permissionId?: string; targetUserId?: string } | null;
  const previousValues = activity.previousValues || {};

  if (!activity.pageId) {
    throw new Error('Page ID not found in activity');
  }

  const targetUserId = metadata?.targetUserId || (previousValues.userId as string);
  if (!targetUserId) {
    throw new Error('Target user ID not found in activity');
  }

  switch (activity.operation) {
    case 'permission_grant': {
      // A permission was granted - rollback by deleting it
      await database
        .delete(pagePermissions)
        .where(
          and(
            eq(pagePermissions.pageId, activity.pageId),
            eq(pagePermissions.userId, targetUserId)
          )
        );

      loggers.api.info('[RollbackService] Deleted permission that was granted', {
        pageId: activity.pageId,
        userId: targetUserId,
      });

      return { deleted: true, pageId: activity.pageId, userId: targetUserId };
    }

    case 'permission_revoke': {
      // A permission was revoked - rollback by re-creating it with previous values
      const permissionData = {
        pageId: activity.pageId,
        userId: targetUserId,
        canView: (previousValues.canView as boolean) ?? false,
        canEdit: (previousValues.canEdit as boolean) ?? false,
        canShare: (previousValues.canShare as boolean) ?? false,
        canDelete: (previousValues.canDelete as boolean) ?? false,
        grantedBy: previousValues.grantedBy as string | null,
        note: previousValues.note as string | null,
      };

      await database.insert(pagePermissions).values(permissionData);

      loggers.api.info('[RollbackService] Re-created revoked permission', {
        pageId: activity.pageId,
        userId: targetUserId,
      });

      return permissionData;
    }

    case 'permission_update': {
      // A permission was updated - rollback by restoring previous values
      const updateData: Record<string, unknown> = {};

      const permissionFields = ['canView', 'canEdit', 'canShare', 'canDelete', 'note', 'expiresAt'];
      for (const field of permissionFields) {
        if (field in previousValues) {
          updateData[field] = previousValues[field];
        }
      }

      if (Object.keys(updateData).length === 0) {
        throw new Error('No permission values to restore');
      }

      await database
        .update(pagePermissions)
        .set(updateData)
        .where(
          and(
            eq(pagePermissions.pageId, activity.pageId),
            eq(pagePermissions.userId, targetUserId)
          )
        );

      loggers.api.info('[RollbackService] Restored previous permission values', {
        pageId: activity.pageId,
        userId: targetUserId,
        restoredFields: Object.keys(updateData),
      });

      return updateData;
    }

    default:
      throw new Error(`Unsupported permission operation: ${activity.operation}`);
  }
}

/**
 * Rollback an agent config change
 */
async function rollbackAgentConfigChange(
  activity: ActivityLogForRollback,
  _currentValues: Record<string, unknown> | null,
  database: typeof db
): Promise<Record<string, unknown>> {
  // Agent configs are stored in pages table
  if (!activity.pageId) {
    throw new Error('Page ID not found in activity');
  }

  const previousValues = activity.previousValues || {};
  const updateData: Record<string, unknown> = {};

  // Agent config fields that can be rolled back
  const agentFields = [
    'systemPrompt',
    'enabledTools',
    'aiProvider',
    'aiModel',
    'includeDrivePrompt',
    'agentDefinition',
    'visibleToGlobalAssistant',
  ];

  for (const field of agentFields) {
    if (field in previousValues) {
      updateData[field] = previousValues[field];
    }
  }

  if (Object.keys(updateData).length === 0) {
    throw new Error('No agent config values to restore');
  }

  await database
    .update(pages)
    .set({
      ...updateData,
      updatedAt: new Date(),
    })
    .where(eq(pages.id, activity.pageId));

  return updateData;
}

/**
 * Rollback a member change
 */
async function rollbackMemberChange(
  activity: ActivityLogForRollback,
  database: typeof db
): Promise<Record<string, unknown>> {
  const metadata = activity.metadata as { memberId?: string; targetUserId?: string } | null;
  const previousValues = activity.previousValues || {};

  if (!activity.driveId) {
    throw new Error('Drive ID not found in activity');
  }

  const targetUserId = metadata?.targetUserId || (previousValues.userId as string);
  if (!targetUserId) {
    throw new Error('Target user ID not found in activity');
  }

  // Determine if this was an add, remove, or role change based on operation and context
  const wasAdded = activity.operation === 'create' || !previousValues.role;
  const wasRemoved = activity.operation === 'delete' || activity.operation === 'trash';

  if (wasAdded && !wasRemoved) {
    // Member was added - rollback by removing them
    await database
      .delete(driveMembers)
      .where(
        and(
          eq(driveMembers.driveId, activity.driveId),
          eq(driveMembers.userId, targetUserId)
        )
      );

    loggers.api.info('[RollbackService] Removed member that was added', {
      driveId: activity.driveId,
      userId: targetUserId,
    });

    return { deleted: true, driveId: activity.driveId, userId: targetUserId };
  }

  if (wasRemoved) {
    // Member was removed - rollback by re-adding them with previous values
    const memberData = {
      driveId: activity.driveId,
      userId: targetUserId,
      role: (previousValues.role as 'OWNER' | 'ADMIN' | 'MEMBER') || 'MEMBER',
      customRoleId: previousValues.customRoleId as string | null,
      invitedBy: previousValues.invitedBy as string | null,
      invitedAt: previousValues.invitedAt ? new Date(previousValues.invitedAt as string) : new Date(),
      acceptedAt: previousValues.acceptedAt ? new Date(previousValues.acceptedAt as string) : new Date(),
    };

    await database.insert(driveMembers).values(memberData);

    loggers.api.info('[RollbackService] Re-added removed member', {
      driveId: activity.driveId,
      userId: targetUserId,
      role: memberData.role,
    });

    return memberData;
  }

  // Role/customRole was changed - restore previous values
  const updateData: Record<string, unknown> = {};

  if ('role' in previousValues) {
    updateData.role = previousValues.role;
  }
  if ('customRoleId' in previousValues) {
    updateData.customRoleId = previousValues.customRoleId;
  }

  if (Object.keys(updateData).length === 0) {
    throw new Error('No member values to restore');
  }

  await database
    .update(driveMembers)
    .set(updateData)
    .where(
      and(
        eq(driveMembers.driveId, activity.driveId),
        eq(driveMembers.userId, targetUserId)
      )
    );

  loggers.api.info('[RollbackService] Restored previous member values', {
    driveId: activity.driveId,
    userId: targetUserId,
    restoredFields: Object.keys(updateData),
  });

  return updateData;
}

/**
 * Rollback a role change
 */
async function rollbackRoleChange(
  activity: ActivityLogForRollback,
  database: typeof db
): Promise<Record<string, unknown>> {
  const metadata = activity.metadata as { roleId?: string } | null;
  const previousValues = activity.previousValues || {};

  if (!activity.driveId) {
    throw new Error('Drive ID not found in activity');
  }

  const roleId = activity.resourceId || metadata?.roleId;
  if (!roleId) {
    throw new Error('Role ID not found in activity');
  }

  // Determine if this was a create, delete, or update
  const wasCreated = activity.operation === 'create';
  const wasDeleted = activity.operation === 'delete' || activity.operation === 'trash';

  if (wasCreated) {
    // Role was created - rollback by deleting it
    await database
      .delete(driveRoles)
      .where(eq(driveRoles.id, roleId));

    loggers.api.info('[RollbackService] Deleted role that was created', {
      driveId: activity.driveId,
      roleId,
    });

    return { deleted: true, roleId };
  }

  if (wasDeleted) {
    // Role was deleted - rollback by re-creating it with previous values
    const roleData = {
      id: roleId,
      driveId: activity.driveId,
      name: (previousValues.name as string) || 'Restored Role',
      description: previousValues.description as string | null,
      color: previousValues.color as string | null,
      isDefault: (previousValues.isDefault as boolean) ?? false,
      permissions: (previousValues.permissions as Record<string, { canView: boolean; canEdit: boolean; canShare: boolean }>) || {},
      position: (previousValues.position as number) ?? 0,
      updatedAt: new Date(),
    };

    await database.insert(driveRoles).values(roleData);

    loggers.api.info('[RollbackService] Re-created deleted role', {
      driveId: activity.driveId,
      roleId,
      name: roleData.name,
    });

    return roleData;
  }

  // Role was updated - restore previous values
  const updateData: Record<string, unknown> = {};

  const roleFields = ['name', 'description', 'color', 'isDefault', 'permissions', 'position'];
  for (const field of roleFields) {
    if (field in previousValues) {
      updateData[field] = previousValues[field];
    }
  }

  if (Object.keys(updateData).length === 0) {
    throw new Error('No role values to restore');
  }

  updateData.updatedAt = new Date();

  await database
    .update(driveRoles)
    .set(updateData)
    .where(eq(driveRoles.id, roleId));

  loggers.api.info('[RollbackService] Restored previous role values', {
    driveId: activity.driveId,
    roleId,
    restoredFields: Object.keys(updateData),
  });

  return updateData;
}

/**
 * Rollback a message change (edit or delete)
 */
async function rollbackMessageChange(
  activity: ActivityLogForRollback,
  database: typeof db
): Promise<Record<string, unknown>> {
  const previousValues = activity.previousValues || {};
  const messageId = activity.resourceId;

  if (!messageId) {
    throw new Error('Message ID not found in activity');
  }

  switch (activity.operation) {
    case 'message_update': {
      // Restore previous content, clear editedAt
      const previousContent = previousValues.content as string;
      if (!previousContent) {
        throw new Error('No previous content found for message rollback');
      }

      await database
        .update(chatMessages)
        .set({
          content: previousContent,
          editedAt: null,
        })
        .where(eq(chatMessages.id, messageId));

      loggers.api.info('[RollbackService] Restored previous message content', {
        messageId,
        pageId: activity.pageId,
      });

      return { content: previousContent, editedAt: null };
    }

    case 'message_delete': {
      // Undelete - set isActive = true
      await database
        .update(chatMessages)
        .set({ isActive: true })
        .where(eq(chatMessages.id, messageId));

      loggers.api.info('[RollbackService] Restored deleted message', {
        messageId,
        pageId: activity.pageId,
      });

      return { restored: true, isActive: true };
    }

    default:
      throw new Error(`Unsupported message operation: ${activity.operation}`);
  }
}

/**
 * Get version history for a page
 */
export async function getPageVersionHistory(
  pageId: string,
  userId: string,
  options: VersionHistoryOptions = {}
): Promise<{ activities: ActivityLogForRollback[]; total: number }> {
  const { limit = 50, offset = 0, startDate, endDate, actorId, operation, includeAiOnly } = options;

  try {
    const conditions = [eq(activityLogs.pageId, pageId)];

    if (startDate) {
      conditions.push(gte(activityLogs.timestamp, startDate));
    }
    if (endDate) {
      conditions.push(lte(activityLogs.timestamp, endDate));
    }
    if (actorId) {
      conditions.push(eq(activityLogs.userId, actorId));
    }
    if (operation && isValidOperation(operation)) {
      conditions.push(eq(activityLogs.operation, operation as typeof activityLogs.operation.enumValues[number]));
    }
    if (includeAiOnly) {
      conditions.push(eq(activityLogs.isAiGenerated, true));
    }

    const [activities, countResult] = await Promise.all([
      db
        .select()
        .from(activityLogs)
        .where(and(...conditions))
        .orderBy(desc(activityLogs.timestamp))
        .limit(limit)
        .offset(offset),
      db
        .select({ value: count() })
        .from(activityLogs)
        .where(and(...conditions)),
    ]);

    return {
      activities: activities.map((a) => ({
        id: a.id,
        timestamp: a.timestamp,
        userId: a.userId,
        actorEmail: a.actorEmail,
        actorDisplayName: a.actorDisplayName,
        operation: a.operation,
        resourceType: a.resourceType as ActivityResourceType,
        resourceId: a.resourceId,
        resourceTitle: a.resourceTitle,
        driveId: a.driveId,
        pageId: a.pageId,
        isAiGenerated: a.isAiGenerated,
        aiProvider: a.aiProvider,
        aiModel: a.aiModel,
        contentSnapshot: a.contentSnapshot,
        updatedFields: a.updatedFields as string[] | null,
        previousValues: a.previousValues as Record<string, unknown> | null,
        newValues: a.newValues as Record<string, unknown> | null,
        metadata: a.metadata as Record<string, unknown> | null,
      })),
      total: countResult[0]?.value ?? 0,
    };
  } catch (error) {
    loggers.api.error('[RollbackService] Error fetching page version history', {
      pageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { activities: [], total: 0 };
  }
}

/**
 * Get version history for a drive (admin view)
 */
export async function getDriveVersionHistory(
  driveId: string,
  userId: string,
  options: VersionHistoryOptions = {}
): Promise<{ activities: ActivityLogForRollback[]; total: number }> {
  const { limit = 50, offset = 0, startDate, endDate, actorId, operation, resourceType } = options;

  try {
    const conditions = [eq(activityLogs.driveId, driveId)];

    if (startDate) {
      conditions.push(gte(activityLogs.timestamp, startDate));
    }
    if (endDate) {
      conditions.push(lte(activityLogs.timestamp, endDate));
    }
    if (actorId) {
      conditions.push(eq(activityLogs.userId, actorId));
    }
    if (operation && isValidOperation(operation)) {
      conditions.push(eq(activityLogs.operation, operation as typeof activityLogs.operation.enumValues[number]));
    }
    if (resourceType) {
      conditions.push(eq(activityLogs.resourceType, resourceType as typeof activityLogs.resourceType.enumValues[number]));
    }

    const [activities, countResult] = await Promise.all([
      db
        .select()
        .from(activityLogs)
        .where(and(...conditions))
        .orderBy(desc(activityLogs.timestamp))
        .limit(limit)
        .offset(offset),
      db
        .select({ value: count() })
        .from(activityLogs)
        .where(and(...conditions)),
    ]);

    return {
      activities: activities.map((a) => ({
        id: a.id,
        timestamp: a.timestamp,
        userId: a.userId,
        actorEmail: a.actorEmail,
        actorDisplayName: a.actorDisplayName,
        operation: a.operation,
        resourceType: a.resourceType as ActivityResourceType,
        resourceId: a.resourceId,
        resourceTitle: a.resourceTitle,
        driveId: a.driveId,
        pageId: a.pageId,
        isAiGenerated: a.isAiGenerated,
        aiProvider: a.aiProvider,
        aiModel: a.aiModel,
        contentSnapshot: a.contentSnapshot,
        updatedFields: a.updatedFields as string[] | null,
        previousValues: a.previousValues as Record<string, unknown> | null,
        newValues: a.newValues as Record<string, unknown> | null,
        metadata: a.metadata as Record<string, unknown> | null,
      })),
      total: countResult[0]?.value ?? 0,
    };
  } catch (error) {
    loggers.api.error('[RollbackService] Error fetching drive version history', {
      driveId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { activities: [], total: 0 };
  }
}

/**
 * Get user's retention limit based on subscription tier
 */
export async function getUserRetentionDays(userId: string): Promise<number> {
  // Default retention days by tier (ordered: free < pro < founder < business)
  const defaultRetention: Record<string, number> = {
    free: 7,
    pro: 30,
    founder: 90,
    business: -1, // unlimited
  };

  try {
    // Get user's subscription tier
    const user = await db
      .select({ subscriptionTier: users.subscriptionTier })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (user.length === 0) {
      return defaultRetention.free;
    }

    const tier = user[0].subscriptionTier || 'free';
    return defaultRetention[tier] || defaultRetention.free;
  } catch (error) {
    loggers.api.error('[RollbackService] Error getting user retention days', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return defaultRetention.free;
  }
}
