import { NextResponse } from 'next/server';
import { createId } from '@paralleldrive/cuid2';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';
import {
  conversationRepository,
  extractPreviewText,
  generateTitle,
} from '@/lib/repositories/conversation-repository';

// Auth options: GET is read-only, POST creates new conversations
const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

/**
 * GET /api/ai/page-agents/[agentId]/conversations
 *
 * Lists all conversations for a specific AI agent with pagination support.
 * Returns conversations in reverse chronological order (most recent first).
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ agentId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;

    const { agentId } = await context.params;

    // Verify agent exists and is AI_CHAT type
    const agent = await conversationRepository.getAiAgent(agentId);

    if (!agent) {
      return NextResponse.json(
        { error: 'AI agent not found' },
        { status: 404 }
      );
    }

    // Check permissions
    const canView = await canUserViewPage(auth.userId, agentId);
    if (!canView) {
      return NextResponse.json(
        { error: 'Insufficient permissions to view this agent' },
        { status: 403 }
      );
    }

    // Get URL params for pagination
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '0', 10);
    const pageSize = parseInt(searchParams.get('pageSize') || '50', 10);
    const offset = page * pageSize;

    // Get conversations with stats
    const conversationsData = await conversationRepository.listConversations(
      agentId,
      pageSize,
      offset
    );

    // Format conversations for response
    const conversations = conversationsData.map(conv => {
      const preview = extractPreviewText(conv.firstUserMessage);
      const title = generateTitle(preview);

      return {
        id: conv.conversationId,
        title,
        preview,
        createdAt: conv.firstMessageTime,
        updatedAt: conv.lastMessageTime,
        messageCount: Number(conv.messageCount),
        lastMessage: {
          role: conv.lastMessageRole,
          timestamp: conv.lastMessageTime,
        },
      };
    });

    // Get total count for pagination
    const totalCount = await conversationRepository.countConversations(agentId);

    return NextResponse.json({
      conversations,
      pagination: {
        page,
        pageSize,
        totalCount,
        totalPages: Math.ceil(totalCount / pageSize),
        hasMore: (page + 1) * pageSize < totalCount,
      },
    });

  } catch (error) {
    loggers.ai.error('Error listing conversations:', error as Error);
    return NextResponse.json(
      { error: 'Failed to list conversations' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/ai/page-agents/[agentId]/conversations
 *
 * Creates a new conversation session for an AI agent. The conversation ID is
 * automatically generated using CUID2 for security and uniqueness.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ agentId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;

    const { agentId } = await context.params;

    // Verify agent exists and is AI_CHAT type
    const agent = await conversationRepository.getAiAgent(agentId);

    if (!agent) {
      return NextResponse.json(
        { error: 'AI agent not found' },
        { status: 404 }
      );
    }

    // Check permissions
    const canView = await canUserViewPage(auth.userId, agentId);
    if (!canView) {
      return NextResponse.json(
        { error: 'Insufficient permissions to create conversations for this agent' },
        { status: 403 }
      );
    }

    // Parse request body (optional custom title)
    const body = await request.json().catch(() => ({}));
    const customTitle = body.title;

    // Generate new conversation ID using createId
    const conversationId = createId();

    return NextResponse.json({
      conversationId,
      title: customTitle || 'New conversation',
      createdAt: new Date(),
    });

  } catch (error) {
    loggers.ai.error('Error creating conversation:', error as Error);
    return NextResponse.json(
      { error: 'Failed to create conversation' },
      { status: 500 }
    );
  }
}
