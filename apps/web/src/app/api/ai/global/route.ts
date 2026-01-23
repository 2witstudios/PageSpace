import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';
import { globalConversationRepository } from '@/lib/repositories/global-conversation-repository';

// Allow streaming responses up to 5 minutes
export const maxDuration = 300;

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

/**
 * GET - List conversations for the authenticated user with optional pagination
 *
 * Query Parameters:
 *   - limit (optional): Max conversations to return (default 20, max 100)
 *   - cursor (optional): Conversation ID for cursor-based pagination
 *   - direction (optional): 'before' (older) or 'after' (newer), default 'before'
 *   - paginated (optional): If 'true', returns paginated response format
 *
 * Without pagination (legacy): Returns array of conversations
 * With pagination: Returns { conversations: [], pagination: { hasMore, nextCursor, prevCursor, limit } }
 */
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { searchParams } = new URL(request.url);
    const usePagination = searchParams.get('paginated') === 'true';
    const limitParam = parseInt(searchParams.get('limit') || '20');
    const limit = isNaN(limitParam) ? 20 : Math.max(1, Math.min(limitParam, 100));
    const cursor = searchParams.get('cursor') || undefined;
    const directionParam = searchParams.get('direction');
    const direction = (directionParam === 'before' || directionParam === 'after')
      ? directionParam
      : 'before';

    if (usePagination) {
      // New paginated response format
      const result = await globalConversationRepository.listConversationsPaginated(userId, {
        limit,
        cursor,
        direction,
      });
      return NextResponse.json(result);
    } else {
      // Legacy response format (array of all conversations)
      // Still supported for backward compatibility
      const userConversations = await globalConversationRepository.listConversations(userId);
      return NextResponse.json(userConversations);
    }
  } catch (error) {
    loggers.api.error('Error fetching conversations:', error as Error);
    return NextResponse.json({
      error: 'Failed to fetch conversations'
    }, { status: 500 });
  }
}

/**
 * POST - Create a new conversation
 */
export async function POST(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const body = await request.json();
    const { title, type = 'global', contextId } = body;

    const newConversation = await globalConversationRepository.createConversation(userId, {
      title,
      type,
      contextId,
    });

    return NextResponse.json(newConversation);
  } catch (error) {
    loggers.api.error('Error creating conversation:', error as Error);
    return NextResponse.json({
      error: 'Failed to create conversation'
    }, { status: 500 });
  }
}
