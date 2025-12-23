/**
 * AI Undo Service
 *
 * Handles undoing AI conversation changes in PageSpace.
 * Supports two modes:
 * 1. messages_only - Just soft-delete messages from a point forward
 * 2. messages_and_changes - Soft-delete messages AND rollback all tool call changes
 */

import { db, chatMessages, activityLogs, eq, and, gte, desc } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import {
  logConversationUndo,
  getActorInfo,
} from '@pagespace/lib/monitoring';
import {
  executeRollback,
  previewRollback,
  type RollbackContext,
} from './rollback-service';

/**
 * Preview of what will be undone
 */
export interface AiUndoPreview {
  messageId: string;
  conversationId: string;
  pageId: string;
  driveId: string | null;
  createdAt: Date; // Message creation timestamp for undo cutoff
  messagesAffected: number;
  activitiesAffected: {
    id: string;
    operation: string;
    resourceType: string;
    resourceId: string;
    resourceTitle: string | null;
    canRollback: boolean;
    reason?: string;
  }[];
  warnings: string[];
}

/**
 * Undo mode - messages only or messages + all tool changes
 */
export type UndoMode = 'messages_only' | 'messages_and_changes';

/**
 * Result of executing an undo operation
 */
export interface AiUndoResult {
  success: boolean;
  messagesDeleted: number;
  activitiesRolledBack: number;
  errors: string[];
}

/**
 * Get a message by ID with its conversation info
 */
async function getMessage(messageId: string) {
  const message = await db.query.chatMessages.findFirst({
    where: eq(chatMessages.id, messageId),
  });
  return message;
}

/**
 * Get page info for a message to determine driveId
 */
async function getPageDriveId(pageId: string): Promise<string | null> {
  const page = await db.query.pages.findFirst({
    where: (pages, { eq }) => eq(pages.id, pageId),
    columns: { driveId: true },
  });
  return page?.driveId ?? null;
}

/**
 * Preview what will be undone if we undo from a specific message
 */
export async function previewAiUndo(
  messageId: string,
  userId: string
): Promise<AiUndoPreview | null> {
  try {
    // Get the message
    const message = await getMessage(messageId);
    if (!message) {
      loggers.api.warn('[AiUndoService] Message not found', { messageId });
      return null;
    }

    const { conversationId, pageId, createdAt } = message;
    const driveId = await getPageDriveId(pageId);

    // Count messages that will be affected (from this message forward in the conversation)
    const affectedMessages = await db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.conversationId, conversationId),
          gte(chatMessages.createdAt, createdAt),
          eq(chatMessages.isActive, true)
        )
      );

    const messagesAffected = affectedMessages.length;

    // Get activity logs for AI-generated changes in this conversation from this point forward
    const activities = await db
      .select()
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.aiConversationId, conversationId),
          eq(activityLogs.isAiGenerated, true),
          gte(activityLogs.timestamp, createdAt)
        )
      )
      .orderBy(desc(activityLogs.timestamp));

    // Check rollback eligibility for each activity
    const activitiesAffected: AiUndoPreview['activitiesAffected'] = [];
    const warnings: string[] = [];

    for (const activity of activities) {
      // Determine context based on resource type
      let context: RollbackContext = 'page';
      if (activity.resourceType === 'drive') {
        context = 'drive';
      } else if (activity.isAiGenerated) {
        context = 'ai_tool';
      }

      const preview = await previewRollback(activity.id, userId, context);

      activitiesAffected.push({
        id: activity.id,
        operation: activity.operation,
        resourceType: activity.resourceType,
        resourceId: activity.resourceId,
        resourceTitle: activity.resourceTitle,
        canRollback: preview.canRollback,
        reason: preview.reason,
      });

      // Collect warnings
      if (!preview.canRollback && preview.reason) {
        warnings.push(`Cannot undo ${activity.operation} on ${activity.resourceTitle || activity.resourceType}: ${preview.reason}`);
      } else if (preview.warnings.length > 0) {
        warnings.push(...preview.warnings);
      }
    }

    return {
      messageId,
      conversationId,
      pageId,
      driveId,
      createdAt,
      messagesAffected,
      activitiesAffected,
      warnings,
    };
  } catch (error) {
    loggers.api.error('[AiUndoService] Error previewing undo', {
      messageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Execute an undo operation
 */
export async function executeAiUndo(
  messageId: string,
  userId: string,
  mode: UndoMode
): Promise<AiUndoResult> {
  const errors: string[] = [];
  let activitiesRolledBack = 0;
  let messagesDeleted = 0;

  try {
    // Get the message and preview
    const preview = await previewAiUndo(messageId, userId);
    if (!preview) {
      return {
        success: false,
        messagesDeleted: 0,
        activitiesRolledBack: 0,
        errors: ['Message not found or preview failed'],
      };
    }

    const { conversationId, pageId, driveId, createdAt } = preview;
    const rolledBackActivityIds: string[] = [];

    // Execute all operations in a single transaction for atomicity
    // All-or-nothing: if any rollback fails, entire transaction is aborted
    await db.transaction(async (tx) => {
      // If mode includes changes, rollback activities in reverse chronological order
      if (mode === 'messages_and_changes') {
        for (const activity of preview.activitiesAffected) {
          if (!activity.canRollback) {
            // Non-rollbackable items abort the entire transaction
            throw new Error(`Cannot undo ${activity.operation} on ${activity.resourceTitle || activity.resourceType}: ${activity.reason}`);
          }

          // Determine context based on resource type
          // Note: All activities here are AI-generated (filtered by query), so we use
          // 'ai_tool' context for pages to match preview logic and permission checks
          let context: RollbackContext = 'ai_tool';
          if (activity.resourceType === 'drive') {
            context = 'drive';
          }

          // Pass transaction to executeRollback for atomicity
          // Any failure aborts entire transaction
          const result = await executeRollback(activity.id, userId, context, tx);
          if (!result.success) {
            throw new Error(`Failed to undo ${activity.operation} on ${activity.resourceTitle || activity.resourceType}: ${result.message}`);
          }
          activitiesRolledBack++;
          rolledBackActivityIds.push(activity.id);
        }
      }

      // Only reached if all rollbacks succeed
      // Soft-delete messages in the same transaction
      await tx
        .update(chatMessages)
        .set({ isActive: false })
        .where(
          and(
            eq(chatMessages.conversationId, conversationId),
            gte(chatMessages.createdAt, createdAt),
            eq(chatMessages.isActive, true)
          )
        );
    });

    // Get count of deleted messages (Drizzle doesn't return count directly, use preview)
    messagesDeleted = preview.messagesAffected;

    // Log the undo operation
    const actorInfo = await getActorInfo(userId);
    logConversationUndo(userId, conversationId, messageId, actorInfo, {
      mode,
      messagesDeleted,
      activitiesRolledBack,
      rolledBackActivityIds: rolledBackActivityIds.length > 0 ? rolledBackActivityIds : undefined,
      pageId,
      driveId,
    });

    loggers.api.info('[AiUndoService] Undo completed', {
      messageId,
      conversationId,
      mode,
      messagesDeleted,
      activitiesRolledBack,
      errorCount: errors.length,
    });

    return {
      success: errors.length === 0,
      messagesDeleted,
      activitiesRolledBack,
      errors,
    };
  } catch (error) {
    loggers.api.error('[AiUndoService] Error executing undo', {
      messageId,
      mode,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      messagesDeleted,
      activitiesRolledBack,
      errors: [...errors, error instanceof Error ? error.message : 'Unknown error'],
    };
  }
}
