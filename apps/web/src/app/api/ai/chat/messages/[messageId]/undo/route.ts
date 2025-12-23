import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserEditPage } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';
import { maskIdentifier } from '@/lib/logging/mask';
import { chatMessageRepository } from '@/lib/repositories/chat-message-repository';
import { globalConversationRepository } from '@/lib/repositories/global-conversation-repository';
import { previewAiUndo, executeAiUndo } from '@/services/api';

// Request body schema for POST /undo
const undoBodySchema = z.object({
  mode: z.enum(['messages_only', 'messages_and_changes']),
});

const AUTH_OPTIONS_READ = { allow: ['jwt', 'mcp'] as const };
const AUTH_OPTIONS_WRITE = { allow: ['jwt', 'mcp'] as const, requireCSRF: true };

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

    // Get preview first to determine source and pageId/conversationId
    const preview = await previewAiUndo(messageId, userId);

    if (!preview) {
      return NextResponse.json({ error: 'Message not found or preview failed' }, { status: 404 });
    }

    // Check permissions based on source
    if (preview.source === 'page_chat') {
      if (!preview.pageId) {
        return NextResponse.json({ error: 'Page ID missing for page chat' }, { status: 500 });
      }
      const canEdit = await canUserEditPage(userId, preview.pageId);
      if (!canEdit) {
        loggers.api.warn('Undo preview permission denied', {
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
        loggers.api.warn('Undo preview permission denied (Global)', {
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

    // Validate request body with Zod
    const parseResult = undoBodySchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: 'Invalid mode. Must be "messages_only" or "messages_and_changes"' },
        { status: 400 }
      );
    }
    const { mode } = parseResult.data;

    // Get preview first to check permissions
    const preview = await previewAiUndo(messageId, userId);

    if (!preview) {
      return NextResponse.json({ error: 'Message not found or preview failed' }, { status: 404 });
    }

    // Check permissions based on source
    if (preview.source === 'page_chat') {
      if (!preview.pageId) {
        return NextResponse.json({ error: 'Page ID missing for page chat' }, { status: 500 });
      }
      const canEdit = await canUserEditPage(userId, preview.pageId);
      if (!canEdit) {
        loggers.api.warn('Undo execution permission denied', {
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
        loggers.api.warn('Undo execution permission denied (Global)', {
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

    // Execute undo
    const result = await executeAiUndo(messageId, userId, mode);

    loggers.api.info('Undo executed', {
      userId: maskIdentifier(userId),
      messageId: maskIdentifier(messageId),
      mode,
      success: result.success,
      messagesDeleted: result.messagesDeleted,
      activitiesRolledBack: result.activitiesRolledBack,
      errorCount: result.errors.length,
    });

    if (!result.success && result.errors.length > 0) {
      // Partial success or failure
      return NextResponse.json(
        {
          ...result,
          success: false,
          message: 'Some operations could not be completed',
        },
        { status: result.messagesDeleted > 0 || result.activitiesRolledBack > 0 ? 207 : 500 }
      );
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
