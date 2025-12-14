import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';
import { globalConversationRepository } from '@/lib/repositories/global-conversation-repository';

// Allow streaming responses up to 5 minutes
export const maxDuration = 300;

const AUTH_OPTIONS_READ = { allow: ['jwt'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['jwt'] as const, requireCSRF: true };

/**
 * GET - List all conversations for the authenticated user
 */
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const userConversations = await globalConversationRepository.listConversations(userId);

    return NextResponse.json(userConversations);
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
