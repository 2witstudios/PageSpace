import { NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth-utils';
import { db, conversations, eq, and, desc } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';
import { loggers } from '@pagespace/lib/logger-config';

// Allow streaming responses up to 60 seconds
export const maxDuration = 60;

/**
 * GET - List all conversations for the authenticated user
 */
export async function GET(request: Request) {
  try {
    const { userId, error } = await authenticateRequest(request);
    if (error) return error;

    const userConversations = await db
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
        eq(conversations.isActive, true)
      ))
      .orderBy(desc(conversations.lastMessageAt));

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
    const { userId, error } = await authenticateRequest(request);
    if (error) return error;

    const body = await request.json();
    const { title, type = 'global', contextId } = body;

    const conversationId = createId();
    const now = new Date();

    const [newConversation] = await db
      .insert(conversations)
      .values({
        id: conversationId,
        userId,
        title: title || null, // Will be auto-generated from first message if not provided
        type,
        contextId: contextId || null,
        lastMessageAt: now,
        createdAt: now,
        updatedAt: now,
        isActive: true,
      })
      .returning();

    return NextResponse.json(newConversation);
  } catch (error) {
    loggers.api.error('Error creating conversation:', error as Error);
    return NextResponse.json({ 
      error: 'Failed to create conversation' 
    }, { status: 500 });
  }
}