import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserEditPage } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';
import { maskIdentifier } from '@/lib/logging/mask';
import { globalConversationRepository } from '@/lib/repositories/global-conversation-repository';
import { previewAiUndo, executeAiUndo, type AiUndoPreview } from '@/services/api';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';

// Request body schema for POST /undo
const undoBodySchema = z.object({
  mode: z.enum(['messages_only', 'messages_and_changes']),
});

const AUTH_OPTIONS_READ = { allow: ['jwt', 'mcp'] as const };
const AUTH_OPTIONS_WRITE = { allow: ['jwt', 'mcp'] as const, requireCSRF: true };

/**
 * Check undo permissions based on preview source
 * Returns a NextResponse if permission denied, null if allowed
 */
async function checkUndoPermissions(
  userId: string,
  messageId: string,
  preview: AiUndoPreview,
  operationType: 'preview' | 'execution'
): Promise<NextResponse | null> {
  if (preview.source === 'page_chat') {
    if (!preview.pageId) {
      return NextResponse.json({ error: 'Page ID missing for page chat' }, { status: 500 });
    }
    const canEdit = await canUserEditPage(userId, preview.pageId);
    if (!canEdit) {
      loggers.api.warn(`Undo ${operationType} permission denied`, {
        userId: maskIdentifier(userId),
        messageId: maskIdentifier(messageId),
        pageId: maskIdentifier(preview.pageId)
      });
      return NextResponse.json(
        { error: 'You do not have permission to undo messages in this chat' },
        { status: 403 }
      );
    }
  } else {
    // Global Assistant chat - verify conversation ownership
    const conversation = await globalConversationRepository.getConversationById(userId, preview.conversationId);
    if (!conversation) {
      loggers.api.warn(`Undo ${operationType} permission denied (Global)`, {
        userId: maskIdentifier(userId),
        messageId: maskIdentifier(messageId),
        conversationId: maskIdentifier(preview.conversationId)
      });
      return NextResponse.json(
        { error: 'You do not have permission to undo messages in this chat' },
        { status: 403 }
      );
    }
  }
  return null;
}

/**
 * GET - Preview what will be undone
 * Returns count of messages and activities that will be affected
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ messageId: string }> }
) {
  try {
    // Authenticate
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { messageId } = await context.params;

    loggers.api.debug('[AiUndo:Route] GET request received', {
      messageId: maskIdentifier(messageId),
      userId: maskIdentifier(userId),
    });

    // Get preview first to determine source and pageId/conversationId
    const preview = await previewAiUndo(messageId, userId);

    if (!preview) {
      return NextResponse.json({ error: 'Message not found or preview failed' }, { status: 404 });
    }

    // Check permissions
    loggers.api.debug('[AiUndo:Route] Checking permissions', {
      source: preview.source,
      pageId: preview.pageId ? maskIdentifier(preview.pageId) : null,
    });
    const permissionError = await checkUndoPermissions(userId, messageId, preview, 'preview');
    if (permissionError) return permissionError;

    loggers.api.debug('[AiUndo:Route] Permission check passed');
    loggers.api.info('Undo preview generated', {
      userId: maskIdentifier(userId),
      messageId: maskIdentifier(messageId),
      messagesAffected: preview.messagesAffected,
      activitiesAffected: preview.activitiesAffected.length,
    });

    return NextResponse.json(preview);
  } catch (error) {
    loggers.api.error('Error generating undo preview', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * POST - Execute undo operation
 * Accepts mode: 'messages_only' | 'messages_and_changes'
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ messageId: string }> }
) {
  try {
    // Authenticate with CSRF
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { messageId } = await context.params;
    const body = await request.json();

    loggers.api.debug('[AiUndo:Route] POST request received', {
      messageId: maskIdentifier(messageId),
      userId: maskIdentifier(userId),
    });

    // Validate request body with Zod
    const parseResult = undoBodySchema.safeParse(body);
    if (!parseResult.success) {
      loggers.api.debug('[AiUndo:Route] Invalid request body');
      return NextResponse.json(
        { error: 'Invalid mode. Must be "messages_only" or "messages_and_changes"' },
        { status: 400 }
      );
    }
    const { mode } = parseResult.data;

    loggers.api.debug('[AiUndo:Route] Validated mode', { mode });

    // Get preview first to check permissions
    const preview = await previewAiUndo(messageId, userId);

    if (!preview) {
      return NextResponse.json({ error: 'Message not found or preview failed' }, { status: 404 });
    }

    // Check permissions
    const permissionError = await checkUndoPermissions(userId, messageId, preview, 'execution');
    if (permissionError) return permissionError;

    loggers.api.debug('[AiUndo:Route] Executing undo', {
      mode,
      messagesAffected: preview.messagesAffected,
      activitiesAffected: preview.activitiesAffected.length,
    });

    // Execute undo, passing preview to avoid redundant computation
    const result = await executeAiUndo(messageId, userId, mode, preview);

    loggers.api.info('Undo executed', {
      userId: maskIdentifier(userId),
      messageId: maskIdentifier(messageId),
      mode,
      success: result.success,
      messagesDeleted: result.messagesDeleted,
      activitiesRolledBack: result.activitiesRolledBack,
      errorCount: result.errors.length,
    });

    if (!result.success) {
      return NextResponse.json(
        {
          ...result,
          success: false,
          message: 'Undo failed. No changes were applied.',
        },
        { status: 500 }
      );
    }

    // Broadcast real-time updates for affected pages
    if (mode === 'messages_and_changes') {
      const broadcastedPages = new Set<string>();
      for (const activity of preview.activitiesAffected) {
        if (activity.resourceType === 'page' && activity.pageId && activity.driveId) {
          // Deduplicate broadcasts for same page
          if (!broadcastedPages.has(activity.pageId)) {
            broadcastedPages.add(activity.pageId);
            await broadcastPageEvent(
              createPageEventPayload(activity.driveId, activity.pageId, 'updated', {
                title: activity.resourceTitle ?? undefined,
              })
            );
          }
        }
      }
      loggers.api.debug('[AiUndo:Route] Broadcasts sent', {
        pageCount: broadcastedPages.size,
      });
    }

    return NextResponse.json({
      ...result,
      success: true,
      message: mode === 'messages_only'
        ? `Deleted ${result.messagesDeleted} messages`
        : `Deleted ${result.messagesDeleted} messages and undid ${result.activitiesRolledBack} changes`,
    });
  } catch (error) {
    loggers.api.error('Error executing undo', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
