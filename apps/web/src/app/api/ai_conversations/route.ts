import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db, conversations, eq, and, desc } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';
import { loggers } from '@pagespace/lib/server';

// Allow streaming responses up to 5 minutes
export const maxDuration = 300;

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

/**
 * GET - List all conversations for the authenticated user
 */
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

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
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

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