import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope } from '@/lib/auth';
import { convertDbMessageToUIMessage } from '@/lib/ai/core';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
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
    if (isAuthError(auth)) {
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'message', resourceId: 'list', details: { reason: 'auth_failed', method: 'GET' }, riskScore: 0.5 });
      return auth.error;
    }

    const { searchParams } = new URL(request.url);
    const pageId = searchParams.get('pageId');
    const conversationId = searchParams.get('conversationId'); // Optional filter

    if (!pageId) {
      return NextResponse.json({ error: 'pageId is required' }, { status: 400 });
    }

    const mcpScopeError = await checkMCPPageScope(auth, pageId);
    if (mcpScopeError) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'message', resourceId: pageId, details: { reason: 'mcp_page_scope_denied', method: 'GET' }, riskScore: 0.5 });
      return mcpScopeError;
    }

    // Check if user has view permission for this page
    const canView = await canUserViewPage(auth.userId, pageId);
    if (!canView) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'message', resourceId: pageId, details: { reason: 'no_view_permission', method: 'GET' }, riskScore: 0.5 });
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

    auditRequest(request, { eventType: 'data.read', userId: auth.userId, resourceType: 'message', resourceId: pageId, details: {
      source: 'ai-chat',
      messageCount: messages.length,
    } });

    return NextResponse.json(messages);

  } catch (error) {
    loggers.ai.error('Error loading chat messages:', error as Error);
    return NextResponse.json({
      error: 'Failed to load messages'
    }, { status: 500 });
  }
}
