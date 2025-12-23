/**
 * AI Undo Service
 *
 * Handles undoing AI conversation changes in PageSpace.
 * Supports two modes:
 * 1. messages_only - Just soft-delete messages from a point forward
 * 2. messages_and_changes - Soft-delete messages AND rollback all tool call changes
 */

import { db, chatMessages, messages, activityLogs, eq, and, gte, desc } from '@pagespace/db';
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
  pageId: string | null;
  driveId: string | null;
  source: MessageSource;
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
 * Source table for the message
 */
export type MessageSource = 'page_chat' | 'global_chat';

/**
 * Normalized message object for undo operations
 */
interface AiMessage {
  id: string;
  conversationId: string;
  pageId: string | null;
  createdAt: Date;
  isActive: boolean;
  source: MessageSource;
}

/**
 * Get a message by ID with its conversation info
 * Tries both chat_messages (page chats) and messages (global chats)
 */
async function getMessage(messageId: string): Promise<AiMessage | null> {
  // Try page chat messages first
  const pageMessage = await db.query.chatMessages.findFirst({
    where: eq(chatMessages.id, messageId),
  });

  if (pageMessage) {
    return {
      id: pageMessage.id,
      conversationId: pageMessage.conversationId,
      pageId: pageMessage.pageId,
      createdAt: pageMessage.createdAt,
      isActive: pageMessage.isActive,
      source: 'page_chat',
    };
  }

  // Try global assistant messages
  const globalMessage = await db.query.messages.findFirst({
    where: eq(messages.id, messageId),
  });

  if (globalMessage) {
    return {
      id: globalMessage.id,
      conversationId: globalMessage.conversationId,
      pageId: null, // Global messages don't have a pageId directly
      createdAt: globalMessage.createdAt,
      isActive: globalMessage.isActive,
      source: 'global_chat',
    };
  }

  return null;
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

    const { conversationId, pageId, createdAt, source } = message;
    const driveId = pageId ? await getPageDriveId(pageId) : null;

    // Count messages that will be affected (from this message forward in the conversation)
    // Use the correct table based on source
    const table = source === 'page_chat' ? chatMessages : messages;

    const affectedMessages = await db
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          eq(table.conversationId, conversationId),
          gte(table.createdAt, createdAt),
          eq(table.isActive, true)
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
      source,
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
      const table = preview.source === 'page_chat' ? chatMessages : messages;

      await tx
        .update(table)
        .set({ isActive: false })
        .where(
          and(
            eq(table.conversationId, conversationId),
            gte(table.createdAt, createdAt),
            eq(table.isActive, true)
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
      pageId: pageId ?? undefined,
      driveId: driveId ?? undefined,
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
