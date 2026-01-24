import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';
import { globalConversationRepository } from '@/lib/repositories/global-conversation-repository';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false };

/**
 * GET - Get any active global conversation for the authenticated user
 * Returns the most recent conversation (by creation time) or null if none exists
 */
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const conversation = await globalConversationRepository.getActiveGlobalConversation(userId);
    return NextResponse.json(conversation);
  } catch (error) {
    loggers.api.error('Error fetching global conversation:', error as Error);
    return NextResponse.json({
      error: 'Failed to fetch global conversation'
    }, { status: 500 });
  }
}
