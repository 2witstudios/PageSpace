/**
 * AI Undo Service
 *
 * Handles undoing AI conversation changes in PageSpace.
 * Supports two modes:
 * 1. messages_only - Just soft-delete messages from a point forward
 * 2. messages_and_changes - Soft-delete messages AND rollback all tool call changes
 */

import { db } from '@pagespace/db/db'
import { eq, and, gte, lt, ne, desc } from '@pagespace/db/operators'
import { activityLogs } from '@pagespace/db/schema/monitoring'
import { messages } from '@pagespace/db/schema/conversations';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  logConversationUndo,
  getActorInfo,
} from '@pagespace/lib/monitoring/activity-logger';
import {
  executeRollback,
  previewRollback,
  type RollbackContext,
} from './rollback-service';
import type { ActivityActionPreview } from '@/types/activity-actions';

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
    pageId?: string | null;
    driveId?: string | null;
    metadata?: Record<string, unknown> | null;
    preview: ActivityActionPreview;
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
 * Get a message by ID with its conversation info.
 *
 * ONE lookup against the UNIFIED `messages` table since the message-table
 * merge (epic "Agent-Session Single Source of Truth", Phase 4 / D6). The
 * "try page chat, then try global" two-table probe is exactly the duplication
 * the merge removes: `source` is now derived from the conversation's own type
 * — `type='global'` is a global thread, anything else is a page/client thread
 * — rather than inferred from which table happened to answer first.
 *
 * That also fixes the old probe's ordering bug in passing: an id present in
 * both tables (the dual-write window makes that the NORMAL state for a page
 * row) was always reported as `page_chat`, which happens to be right, but only
 * by accident of statement order.
 */
async function getMessage(messageId: string): Promise<AiMessage | null> {
  loggers.api.debug('[AiUndo:Preview] Looking up message', { messageId });

  const row = await db.query.messages.findFirst({
    where: eq(messages.id, messageId),
    // The conversation carries the two facts this lookup exists to derive:
    // which KIND of thread it is, and (for a page thread) which page.
    with: { conversation: { columns: { type: true, contextId: true } } },
  });

  if (!row) {
    loggers.api.debug('[AiUndo:Preview] Message not found', { messageId });
    return null;
  }

  const conversationType = row.conversation?.type;
  const source: MessageSource = conversationType === 'global' ? 'global_chat' : 'page_chat';
  // A global thread has no page (and its `contextId` is NULL by CHECK). A page
  // thread's page IS `contextId`; a `type='client'` thread still carries it in
  // the transitional column — the same derivation `unifiedPageScope` documents.
  const pageId = source === 'global_chat'
    ? null
    : (conversationType === 'page' ? (row.conversation?.contextId ?? null) : row.pageId);

  loggers.api.debug('[AiUndo:Preview] Message found', {
    messageId,
    conversationId: row.conversationId,
    pageId,
    source,
    isActive: row.isActive,
  });

  return {
    id: row.id,
    conversationId: row.conversationId,
    pageId,
    createdAt: row.createdAt,
    isActive: row.isActive,
    source,
  };
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
  loggers.api.debug('[AiUndo:Preview] Starting preview', { messageId, userId });

  try {
    // Get the message
    const message = await getMessage(messageId);
    if (!message) {
      loggers.api.warn('[AiUndoService] Message not found', { messageId });
      return null;
    }

    const { conversationId, pageId, createdAt, source } = message;
    loggers.api.debug('[AiUndo:Preview] Message context resolved', {
      conversationId,
      pageId,
      source,
      createdAt: createdAt.toISOString(),
    });

    const driveId = pageId ? await getPageDriveId(pageId) : null;
    loggers.api.debug('[AiUndo:Preview] Drive context resolved', { driveId });

    // Count messages that will be affected (from this message forward in the
    // conversation). One table since the merge — the `source` ternary that used
    // to pick between `chat_messages` and `messages` is gone, and with it the
    // question of which table the count and the sweep each looked at. `source`
    // survives because callers still report it.
    //
    // Scoped by conversationId ALONE, as the plan's D6 calls for: a
    // conversation id is a cuid2 and already names one thread.
    //
    // SAFE DEFAULT (undo-vs-in-flight-stream UX still needs a product call — see the PR 2
    // board's "Open decision"): a 'streaming' row is excluded from the sweep entirely, not
    // just skipped in the count. Undo must never soft-delete a row a live generation still
    // owns — its execute-end/onFinish upsert doesn't check isActive, so soft-deleting it here
    // would leave a hidden row that silently reappears with real content once the stream
    // finishes. Everything else in range still gets undone; only the live placeholder is left
    // untouched. See Server Stream Durability epic PR 2.
    const affectedMessages = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          gte(messages.createdAt, createdAt),
          eq(messages.isActive, true),
          ne(messages.status, 'streaming')
        )
      );

    const messagesAffected = affectedMessages.length;
    loggers.api.debug('[AiUndo:Preview] Counted affected messages', {
      messagesAffected,
      conversationId,
    });

    // Find the message immediately preceding this one in the same conversation
    // to include any tool calls that happened before this message was created
    const precedingMessage = await db.query.messages.findFirst({
      where: and(
        eq(messages.conversationId, conversationId),
        lt(messages.createdAt, createdAt),
        eq(messages.isActive, true)
      ),
      orderBy: desc(messages.createdAt),
    });

    // Use preceding message's timestamp (if it exists) to catch all activities in this turn
    // If no preceding message, we still start from createdAt but tool calls might be missed
    // in the first turn, but usually there's a user message first.
    const activityStartTime = precedingMessage ? precedingMessage.createdAt : createdAt;
    loggers.api.debug('[AiUndo:Preview] Activity time window resolved', {
      hasPrecedingMessage: !!precedingMessage,
      activityStartTime: activityStartTime.toISOString(),
    });

    // Get activity logs for AI-generated changes in this conversation from this point forward
    loggers.api.debug('[AiUndo:Preview] Querying AI-generated activities', {
      conversationId,
      fromTimestamp: activityStartTime.toISOString(),
    });
    const activities = await db
      .select()
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.aiConversationId, conversationId),
          eq(activityLogs.isAiGenerated, true),
          gte(activityLogs.timestamp, activityStartTime)
        )
      )
      .orderBy(desc(activityLogs.timestamp));

    loggers.api.debug('[AiUndo:Preview] Found AI activities', {
      activitiesCount: activities.length,
    });

    // Check rollback eligibility for each activity
    const activitiesAffected: AiUndoPreview['activitiesAffected'] = [];
    const warnings: string[] = [];
    const fallbackPreview = (reason: string): ActivityActionPreview => ({
      action: 'rollback',
      canExecute: false,
      reason,
      warnings: [],
      hasConflict: false,
      conflictFields: [],
      requiresForce: false,
      isNoOp: false,
      currentValues: null,
      targetValues: null,
      changes: [],
      affectedResources: [],
    });

    // Collect all activity IDs upfront so we can pass them as the undo group context
    // This allows conflict detection to ignore "internal" conflicts from activities
    // that are part of the same undo operation
    const undoGroupActivityIds = activities.map(a => a.id);

    for (const activity of activities) {
      // Activities are already filtered for isAiGenerated=true by the query above,
      // so we use 'ai_tool' context for pages and 'drive' context for drives
      const context: RollbackContext = activity.resourceType === 'drive' ? 'drive' : 'ai_tool';

      loggers.api.debug('[AiUndo:Preview] Checking activity eligibility', {
        activityId: activity.id,
        operation: activity.operation,
        resourceType: activity.resourceType,
        resourceTitle: activity.resourceTitle,
        context,
      });

      let preview: ActivityActionPreview;
      try {
        preview = await previewRollback(activity.id, userId, context, { undoGroupActivityIds });
        if (!preview) {
          preview = fallbackPreview('Preview failed');
          warnings.push(`Could not preview undo for activity ${activity.id}`);
        }
      } catch (error) {
        preview = fallbackPreview('Preview failed');
        warnings.push(`Failed to preview ${activity.operation} on ${activity.resourceTitle || activity.resourceType}: ${error instanceof Error ? error.message : String(error)}`);
      }

      loggers.api.debug('[AiUndo:Preview] Activity eligibility result', {
        activityId: activity.id,
        canExecute: preview.canExecute,
        isNoOp: preview.isNoOp,
        reason: preview.reason,
        warningsCount: preview.warnings.length,
      });

      // Skip no-op activities (e.g., pages already trashed from previous sessions)
      // These are silently filtered out to show accurate count of real changes
      if (preview.isNoOp) {
        loggers.api.debug('[AiUndo:Preview] Skipping no-op activity', {
          activityId: activity.id,
          operation: activity.operation,
          resourceTitle: activity.resourceTitle,
        });
        continue;
      }

      activitiesAffected.push({
        id: activity.id,
        operation: activity.operation,
        resourceType: activity.resourceType,
        resourceId: activity.resourceId,
        resourceTitle: activity.resourceTitle,
        pageId: activity.pageId,
        driveId: activity.driveId,
        metadata: activity.metadata as Record<string, unknown> | null,
        preview,
      });

      // Collect warnings
      if (!preview.canExecute && preview.reason) {
        warnings.push(`Cannot undo ${activity.operation} on ${activity.resourceTitle || activity.resourceType}: ${preview.reason}`);
      } else if (preview.warnings.length > 0) {
        warnings.push(...preview.warnings);
      }
    }

    loggers.api.debug('[AiUndo:Preview] Preview complete', {
      messagesAffected,
      activitiesTotal: activitiesAffected.length,
      activitiesRollbackable: activitiesAffected.filter(a => a.preview.canExecute).length,
      warningsCount: warnings.length,
    });

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
 * @param existingPreview - Optional pre-computed preview to avoid redundant database queries
 */
export async function executeAiUndo(
  messageId: string,
  userId: string,
  mode: UndoMode,
  existingPreview?: AiUndoPreview,
  options?: { force?: boolean }
): Promise<AiUndoResult> {
  loggers.api.debug('[AiUndo:Execute] Starting execution', {
    messageId,
    userId,
    mode,
    hasExistingPreview: !!existingPreview,
  });

  const force = options?.force ?? false;
  const errors: string[] = [];
  let activitiesRolledBack = 0;
  let messagesDeleted = 0;

  try {
    let message: AiMessage | null;
    try {
      message = await getMessage(messageId);
    } catch (error) {
      loggers.api.error('[AiUndoService] Error fetching message', {
        messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        messagesDeleted: 0,
        activitiesRolledBack: 0,
        errors: ['Message not found or preview failed'],
      };
    }

    /**
     * Idempotency contract: an inactive message represents an already-achieved
     * end-state. Returning success with zero counts lets callers (route handlers,
     * retries, double-click guards) treat repeated calls as no-ops rather than
     * errors — matching standard HTTP idempotency semantics.
     */
    if (!message) {
      loggers.api.debug('[AiUndo:Execute] Aborting - message not found');
      return {
        success: false,
        messagesDeleted: 0,
        activitiesRolledBack: 0,
        errors: ['Message not found or preview failed'],
      };
    }

    if (!message.isActive) {
      loggers.api.debug('[AiUndo:Execute] Idempotent return - message already inactive', {
        messageId,
      });
      return {
        success: true,
        messagesDeleted: 0,
        activitiesRolledBack: 0,
        errors: [],
      };
    }

    // Use existing preview if provided, otherwise compute it
    const preview = existingPreview ?? await previewAiUndo(messageId, userId);
    if (!preview) {
      loggers.api.debug('[AiUndo:Execute] Aborting - preview not available');
      return {
        success: false,
        messagesDeleted: 0,
        activitiesRolledBack: 0,
        errors: ['Message not found or preview failed'],
      };
    }

    const { conversationId, pageId, driveId, createdAt } = preview;
    const rolledBackActivityIds: string[] = [];

    loggers.api.debug('[AiUndo:Execute] Preview resolved', {
      conversationId,
      messagesAffected: preview.messagesAffected,
      activitiesAffected: preview.activitiesAffected.length,
      source: preview.source,
    });

    // Execute all operations in a single transaction for atomicity
    // All-or-nothing: if any rollback fails, entire transaction is aborted
    loggers.api.debug('[AiUndo:Execute] Starting transaction');

    const deferredTriggers: Array<() => void> = [];

    await db.transaction(async (tx) => {
      // If mode includes changes, rollback activities in reverse chronological order
      if (mode === 'messages_and_changes') {
        // Collect all activity IDs for undo group context - allows conflict detection
        // to ignore "internal" conflicts from other activities in the same undo batch
        const undoGroupActivityIds = preview.activitiesAffected.map(a => a.id);

        loggers.api.debug('[AiUndo:Execute] Rolling back activities', {
          activitiesToRollback: preview.activitiesAffected.length,
        });

        for (const activity of preview.activitiesAffected) {
          const activityPreview = activity.preview;
          if (!activityPreview.canExecute) {
            loggers.api.debug('[AiUndo:Execute] Activity not rollbackable - aborting', {
              activityId: activity.id,
              reason: activityPreview.reason,
            });
            const canForceOverride = force && activityPreview.requiresForce;
            if (!canForceOverride) {
              throw new Error(`Cannot undo ${activity.operation} on ${activity.resourceTitle || activity.resourceType}: ${activityPreview.reason}`);
            }
          }

          // Determine context based on resource type
          // Note: All activities here are AI-generated (filtered by query), so we use
          // 'ai_tool' context for pages to match preview logic and permission checks
          let context: RollbackContext = 'ai_tool';
          if (activity.resourceType === 'drive') {
            context = 'drive';
          }

          loggers.api.debug('[AiUndo:Execute] Rolling back activity', {
            activityId: activity.id,
            operation: activity.operation,
            resourceType: activity.resourceType,
            context,
          });

          // Pass transaction to executeRollback for atomicity
          // Any failure aborts entire transaction
          const result = await executeRollback(activity.id, userId, context, { tx, force, undoGroupActivityIds });
          if (!result.success) {
            loggers.api.debug('[AiUndo:Execute] Activity rollback failed - aborting', {
              activityId: activity.id,
              message: result.message,
            });
            throw new Error(`Failed to undo ${activity.operation} on ${activity.resourceTitle || activity.resourceType}: ${result.message}`);
          }

          if (result.deferredWorkflowTrigger) {
            deferredTriggers.push(result.deferredWorkflowTrigger);
          }

          loggers.api.debug('[AiUndo:Execute] Activity rollback succeeded', {
            activityId: activity.id,
          });

          activitiesRolledBack++;
          rolledBackActivityIds.push(activity.id);
        }
      }

      // Only reached if all rollbacks succeed: soft-delete the undone range
      // in the same transaction.
      loggers.api.debug('[AiUndo:Execute] Soft-deleting messages', {
        source: preview.source,
        conversationId,
        fromTimestamp: createdAt.toISOString(),
      });

      // `messages` — the one table every reader consults and, since Phase 4
      // PR 14, the only one anything writes. The mirrored `chat_messages`
      // tombstone that used to follow this statement is gone with the rest of
      // the legacy leg. Excludes 'streaming' rows: see the SAFE DEFAULT note
      // on previewAiUndo's affectedMessages query above; the same exclusion
      // must apply to the actual mutation, not just its preview count.
      await tx
        .update(messages)
        .set({ isActive: false })
        .where(
          and(
            eq(messages.conversationId, conversationId),
            gte(messages.createdAt, createdAt),
            eq(messages.isActive, true),
            ne(messages.status, 'streaming')
          )
        );

      loggers.api.debug('[AiUndo:Execute] Transaction committing');
    });

    // Fire deferred workflow triggers after transaction commit
    for (const trigger of deferredTriggers) {
      trigger();
    }

    // Get count of deleted messages (Drizzle doesn't return count directly, use preview)
    messagesDeleted = preview.messagesAffected;

    loggers.api.debug('[AiUndo:Execute] Transaction committed successfully', {
      messagesDeleted,
      activitiesRolledBack,
    });

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
      messagesDeleted: 0,
      activitiesRolledBack: 0,
      errors: [...errors, error instanceof Error ? error.message : 'Unknown error'],
    };
  }
}
