import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { chatMessageRepository } from '@/lib/repositories/chat-message-repository';
import { globalConversationRepository } from '@/lib/repositories/global-conversation-repository';

/**
 * Cron endpoint to hard-delete soft-deleted messages and conversations.
 *
 * Removes rows that have been soft-deleted (isActive=false) for longer than
 * 30 days, permanently freeing storage.
 *
 * Trigger via:
 * curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/purge-deleted-messages
 */
export async function GET(request: Request) {
  const authError = validateSignedCronRequest(request);
  if (authError) {
    return authError;
  }

  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const chatMessagesPurged = await chatMessageRepository.purgeInactiveMessages(thirtyDaysAgo);
    const globalMessagesPurged = await globalConversationRepository.purgeInactiveMessages(thirtyDaysAgo);
    const conversationsPurged = await globalConversationRepository.purgeInactiveConversations(thirtyDaysAgo);

    console.log(
      `[Cron] Purged deleted messages: chat=${chatMessagesPurged}, global=${globalMessagesPurged}, conversations=${conversationsPurged}`
    );

    return NextResponse.json({
      success: true,
      chatMessagesPurged,
      globalMessagesPurged,
      conversationsPurged,
      timestamp: now.toISOString(),
    });
  } catch (error) {
    console.error('[Cron] Error purging deleted messages:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
