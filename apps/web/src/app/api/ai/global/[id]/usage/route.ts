import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';
import { getContextWindow } from '@pagespace/lib/ai-monitoring';
import {
  globalConversationRepository,
  calculateUsageSummary,
} from '@/lib/repositories/global-conversation-repository';

const AUTH_OPTIONS = { allow: ['jwt'] as const };

/**
 * GET - Get AI usage statistics for a specific conversation
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { id } = await context.params;

    // Verify the conversation belongs to the user
    const conversation = await globalConversationRepository.getConversationById(userId, id);
    if (!conversation) {
      return NextResponse.json({
        error: 'Conversation not found'
      }, { status: 404 });
    }

    // Fetch all usage logs for this conversation
    const logs = await globalConversationRepository.getUsageLogs(id);

    // Calculate summary statistics (pure function)
    const summary = calculateUsageSummary(logs, getContextWindow);

    return NextResponse.json({
      logs,
      summary,
    });
  } catch (error) {
    loggers.api.error('Error fetching AI usage:', error as Error);
    return NextResponse.json({
      error: 'Failed to fetch AI usage'
    }, { status: 500 });
  }
}

// Re-export pure function for testing
export { calculateUsageSummary };
