import { NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth-utils';
import { db, conversations, eq, and, desc } from '@pagespace/db';
import { loggers } from '@pagespace/lib/logger-config';

/**
 * GET - Get any active global conversation for the authenticated user
 * Returns the most recent conversation (by creation time) or null if none exists
 */
export async function GET(request: Request) {
  try {
    const { userId, error } = await authenticateRequest(request);
    if (error) return error;

    // Just get ANY global conversation for this user (most recent by creation time)
    const globalConversation = await db
      .select({
        id: conversations.id,
        title: conversations.title,
        type: conversations.type,
        contextId: conversations.contextId,
        lastMessageAt: conversations.lastMessageAt,
        createdAt: conversations.createdAt,
      })
      .from(conversations)
      .where(and(
        eq(conversations.userId, userId),
        eq(conversations.type, 'global'),
        eq(conversations.isActive, true)
      ))
      .orderBy(desc(conversations.createdAt)) // Most recent by creation time
      .limit(1);

    const conversation = globalConversation[0] || null;
    return NextResponse.json(conversation);
  } catch (error) {
    loggers.api.error('Error fetching global conversation:', error as Error);
    return NextResponse.json({ 
      error: 'Failed to fetch global conversation' 
    }, { status: 500 });
  }
}