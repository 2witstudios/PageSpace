import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope } from '@/lib/auth';
import { convertDbMessageToUIMessage } from '@/lib/ai/core';
import { loggers, canUserViewPage } from '@pagespace/lib/server';
import { logAuditEvent } from '@/lib/audit/route-audit';
import { chatMessageRepository } from '@/lib/repositories/chat-message-repository';

// Auth options: GET is read-only operation
const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };

/**
 * GET handler to load chat messages for a page
 * Direct database query for workspace chat messages
 */
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;

    const { searchParams } = new URL(request.url);
    const pageId = searchParams.get('pageId');
    const conversationId = searchParams.get('conversationId'); // Optional filter

    if (!pageId) {
      return NextResponse.json({ error: 'pageId is required' }, { status: 400 });
    }

    const mcpScopeError = await checkMCPPageScope(auth, pageId);
    if (mcpScopeError) return mcpScopeError;

    // Check if user has view permission for this page
    const canView = await canUserViewPage(auth.userId, pageId);
    if (!canView) {
      return NextResponse.json({
        error: 'You need view permission to access this page\'s chat messages',
        details: 'Contact the page owner to request access'
      }, { status: 403 });
    }

    // Get messages from repository
    const dbMessages = await chatMessageRepository.getMessagesForPage(
      pageId,
      conversationId || undefined
    );

    // Convert to UIMessage format with tool calls and results
    const messages = dbMessages.map(convertDbMessageToUIMessage);

    logAuditEvent(request, auth.userId, 'read', 'ai_chat_message', pageId, {
      action: 'list_messages',
      conversationId: conversationId || undefined,
    });

    return NextResponse.json(messages);

  } catch (error) {
    loggers.ai.error('Error loading chat messages:', error as Error);
    return NextResponse.json({
      error: 'Failed to load messages'
    }, { status: 500 });
  }
}
