import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';
import { globalConversationRepository } from '@/lib/repositories/global-conversation-repository';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

/**
 * GET - Get a specific conversation with its messages
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { id } = await context.params;

    const conversation = await globalConversationRepository.getConversationById(userId, id);

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
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { id } = await context.params;
    const body = await request.json();
    const { title } = body;

    const updatedConversation = await globalConversationRepository.updateConversationTitle(
      userId,
      id,
      title
    );

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
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { id } = await context.params;

    const deletedConversation = await globalConversationRepository.softDeleteConversation(
      userId,
      id
    );

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
