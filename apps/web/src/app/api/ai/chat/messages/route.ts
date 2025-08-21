import { NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth-utils';
import { db, chatMessages, eq, and } from '@pagespace/db';
import { convertDbMessageToUIMessage } from '@/lib/ai/assistant-utils';
import { loggers } from '@pagespace/lib/logger-config';

/**
 * GET handler to load chat messages for a page
 * Direct database query for workspace chat messages
 */
export async function GET(request: Request) {
  try {
    const { error } = await authenticateRequest(request);
    if (error) return error;

    const { searchParams } = new URL(request.url);
    const pageId = searchParams.get('pageId');

    if (!pageId) {
      return NextResponse.json({ error: 'pageId is required' }, { status: 400 });
    }

    // Direct database query for messages
    const dbMessages = await db
      .select()
      .from(chatMessages)
      .where(and(
        eq(chatMessages.pageId, pageId),
        eq(chatMessages.isActive, true)
      ))
      .orderBy(chatMessages.createdAt);

    // Convert to UIMessage format with tool calls and results
    const messages = dbMessages.map(convertDbMessageToUIMessage);

    return NextResponse.json(messages);

  } catch (error) {
    loggers.ai.error('Error loading chat messages:', error as Error);
    return NextResponse.json({ 
      error: 'Failed to load messages' 
    }, { status: 500 });
  }
}