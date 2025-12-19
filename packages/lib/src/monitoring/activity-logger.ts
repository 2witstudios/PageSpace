/**
 * Activity Logger - Enterprise-grade audit trail for PageSpace
 *
 * Fire-and-forget async logging with zero performance impact.
 * Designed for auditability with future rollback support.
 */

import { db, activityLogs, users, eq } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';

/**
 * Actor info for audit logging - snapshotted at write time
 */
export interface ActorInfo {
  actorEmail: string;
  actorDisplayName?: string;
}

/**
 * Fetch actor info from database for audit logging.
 * Returns email and display name for the given user ID.
 * Falls back to 'unknown@system' if user not found (shouldn't happen).
 */
export async function getActorInfo(userId: string): Promise<ActorInfo> {
  try {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { email: true, name: true },
    });

    if (!user) {
      console.warn(`[ActivityLogger] User ${userId} not found for actor info`);
      return { actorEmail: 'unknown@system' };
    }

    return {
      actorEmail: user.email,
      actorDisplayName: user.name ?? undefined,
    };
  } catch (error) {
    console.error('[ActivityLogger] Failed to fetch actor info:', error);
    return { actorEmail: 'unknown@system' };
  }
}

// Type definitions matching the database schema
export type ActivityOperation =
  | 'create'
  | 'update'
  | 'delete'
  | 'restore'
  | 'reorder'
  | 'permission_grant'
  | 'permission_update'
  | 'permission_revoke'
  | 'trash'
  | 'move'
  | 'agent_config_update';

export type ActivityResourceType = 'page' | 'drive' | 'permission' | 'agent';

export interface ActivityLogInput {
  userId: string;
  operation: ActivityOperation;
  resourceType: ActivityResourceType;
  resourceId: string;
  resourceTitle?: string;
  driveId: string;
  pageId?: string;

  // Actor snapshot - denormalized for audit trail preservation after user deletion
  actorEmail: string;
  actorDisplayName?: string;

  // AI attribution
  isAiGenerated?: boolean;
  aiProvider?: string;
  aiModel?: string;
  aiConversationId?: string;

  // Content & change tracking
  contentSnapshot?: string;
  updatedFields?: string[];
  previousValues?: Record<string, unknown>;
  newValues?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Log an activity event to the database.
 * Fire-and-forget pattern - never blocks the caller.
 */
export async function logActivity(input: ActivityLogInput): Promise<void> {
  try {
    await db.insert(activityLogs).values({
      id: createId(),
      timestamp: new Date(),
      userId: input.userId,
      actorEmail: input.actorEmail,
      actorDisplayName: input.actorDisplayName,
      operation: input.operation,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      resourceTitle: input.resourceTitle,
      driveId: input.driveId,
      pageId: input.pageId,
      isAiGenerated: input.isAiGenerated ?? false,
      aiProvider: input.aiProvider,
      aiModel: input.aiModel,
      aiConversationId: input.aiConversationId,
      contentSnapshot: input.contentSnapshot,
      updatedFields: input.updatedFields,
      previousValues: input.previousValues,
      newValues: input.newValues,
      metadata: input.metadata,
      isArchived: false,
    });
  } catch (error) {
    // Fire and forget - log error but don't throw
    console.error('[ActivityLogger] Failed to log activity:', error);
  }
}

/**
 * Convenience wrapper for page operations.
 * Fire-and-forget - call without await.
 */
export function logPageActivity(
  userId: string,
  operation: ActivityOperation,
  page: {
    id: string;
    title?: string;
    driveId: string;
    content?: string;
  },
  options?: {
    actorEmail?: string;
    actorDisplayName?: string;
    isAiGenerated?: boolean;
    aiProvider?: string;
    aiModel?: string;
    aiConversationId?: string;
    updatedFields?: string[];
    previousValues?: Record<string, unknown>;
    newValues?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }
): void {
  logActivity({
    userId,
    actorEmail: options?.actorEmail ?? 'unknown@system',
    actorDisplayName: options?.actorDisplayName,
    operation,
    resourceType: 'page',
    resourceId: page.id,
    resourceTitle: page.title,
    driveId: page.driveId,
    pageId: page.id,
    contentSnapshot: page.content,
    isAiGenerated: options?.isAiGenerated,
    aiProvider: options?.aiProvider,
    aiModel: options?.aiModel,
    aiConversationId: options?.aiConversationId,
    updatedFields: options?.updatedFields,
    previousValues: options?.previousValues,
    newValues: options?.newValues,
    metadata: options?.metadata,
  }).catch(() => {
    // Silent fail - already logged in logActivity
  });
}

/**
 * Convenience wrapper for permission operations.
 * Fire-and-forget - call without await.
 */
export function logPermissionActivity(
  userId: string,
  operation: 'permission_grant' | 'permission_update' | 'permission_revoke',
  data: {
    pageId: string;
    driveId: string;
    targetUserId: string;
    permissions?: {
      canView?: boolean;
      canEdit?: boolean;
      canShare?: boolean;
      canDelete?: boolean;
    };
    pageTitle?: string;
  },
  options?: {
    actorEmail?: string;
    actorDisplayName?: string;
  }
): void {
  logActivity({
    userId,
    actorEmail: options?.actorEmail ?? 'unknown@system',
    actorDisplayName: options?.actorDisplayName,
    operation,
    resourceType: 'permission',
    resourceId: data.pageId,
    resourceTitle: data.pageTitle,
    driveId: data.driveId,
    pageId: data.pageId,
    metadata: {
      targetUserId: data.targetUserId,
      permissions: data.permissions,
    },
  }).catch(() => {
    // Silent fail - already logged in logActivity
  });
}

/**
 * Convenience wrapper for drive operations.
 * Fire-and-forget - call without await.
 */
export function logDriveActivity(
  userId: string,
  operation: ActivityOperation,
  drive: {
    id: string;
    name?: string;
  },
  options?: {
    actorEmail?: string;
    actorDisplayName?: string;
    isAiGenerated?: boolean;
    aiProvider?: string;
    aiModel?: string;
    aiConversationId?: string;
    metadata?: Record<string, unknown>;
  }
): void {
  logActivity({
    userId,
    actorEmail: options?.actorEmail ?? 'unknown@system',
    actorDisplayName: options?.actorDisplayName,
    operation,
    resourceType: 'drive',
    resourceId: drive.id,
    resourceTitle: drive.name,
    driveId: drive.id,
    isAiGenerated: options?.isAiGenerated,
    aiProvider: options?.aiProvider,
    aiModel: options?.aiModel,
    aiConversationId: options?.aiConversationId,
    metadata: options?.metadata,
  }).catch(() => {
    // Silent fail - already logged in logActivity
  });
}

/**
 * Convenience wrapper for agent config operations.
 * Fire-and-forget - call without await.
 */
export function logAgentConfigActivity(
  userId: string,
  agent: {
    id: string;
    name?: string;
    driveId: string;
  },
  changes: {
    updatedFields?: string[];
    previousValues?: Record<string, unknown>;
    newValues?: Record<string, unknown>;
    isAiGenerated?: boolean;
    aiProvider?: string;
    aiModel?: string;
    aiConversationId?: string;
  },
  options?: {
    actorEmail?: string;
    actorDisplayName?: string;
  }
): void {
  logActivity({
    userId,
    actorEmail: options?.actorEmail ?? 'unknown@system',
    actorDisplayName: options?.actorDisplayName,
    operation: 'agent_config_update',
    resourceType: 'agent',
    resourceId: agent.id,
    resourceTitle: agent.name,
    driveId: agent.driveId,
    pageId: agent.id, // Agents are stored as pages
    isAiGenerated: changes.isAiGenerated,
    aiProvider: changes.aiProvider,
    aiModel: changes.aiModel,
    aiConversationId: changes.aiConversationId,
    updatedFields: changes.updatedFields,
    previousValues: changes.previousValues,
    newValues: changes.newValues,
  }).catch(() => {
    // Silent fail - already logged in logActivity
  });
}
