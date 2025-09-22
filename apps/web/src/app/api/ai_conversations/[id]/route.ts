import { NextResponse } from 'next/server';
import { authenticateWebRequest, isAuthError } from '@/lib/auth';
import { db, conversations, eq, and } from '@pagespace/db';
import { loggers } from '@pagespace/lib/logger-config';

/**
 * GET - Get a specific conversation with its messages
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authenticateWebRequest(request);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const { id } = await context.params;

    // Get conversation
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(and(
        eq(conversations.id, id),
        eq(conversations.userId, userId),
        eq(conversations.isActive, true)
      ));

    if (!conversation) {
      return NextResponse.json({ 
        error: 'Conversation not found' 
      }, { status: 404 });
    }

    return NextResponse.json(conversation);
  } catch (error) {
    loggers.api.error('Error fetching conversation:', error as Error);
    return NextResponse.json({ 
      error: 'Failed to fetch conversation' 
    }, { status: 500 });
  }
}

/**
 * PATCH - Update conversation (e.g., title)
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authenticateWebRequest(request);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const { id } = await context.params;
    const body = await request.json();
    const { title } = body;

    const [updatedConversation] = await db
      .update(conversations)
      .set({
        title,
        updatedAt: new Date(),
      })
      .where(and(
        eq(conversations.id, id),
        eq(conversations.userId, userId)
      ))
      .returning();

    if (!updatedConversation) {
      return NextResponse.json({ 
        error: 'Conversation not found' 
      }, { status: 404 });
    }

    return NextResponse.json(updatedConversation);
  } catch (error) {
    loggers.api.error('Error updating conversation:', error as Error);
    return NextResponse.json({ 
      error: 'Failed to update conversation' 
    }, { status: 500 });
  }
}

/**
 * DELETE - Delete a conversation
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authenticateWebRequest(request);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const { id } = await context.params;

    // Soft delete by setting isActive to false
    const [deletedConversation] = await db
      .update(conversations)
      .set({
        isActive: false,
        updatedAt: new Date(),
      })
      .where(and(
        eq(conversations.id, id),
        eq(conversations.userId, userId)
      ))
      .returning();

    if (!deletedConversation) {
      return NextResponse.json({ 
        error: 'Conversation not found' 
      }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error deleting conversation:', error as Error);
    return NextResponse.json({ 
      error: 'Failed to delete conversation' 
    }, { status: 500 });
  }
}