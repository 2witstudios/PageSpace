import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { dmMessageRepository } from '@pagespace/lib/services/dm-message-repository';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

type RouteParams = { params: Promise<{ conversationId: string; messageId: string }> };

/**
 * POST /api/messages/[conversationId]/[messageId]/follow
 *
 * Idempotently subscribes the caller to thread updates for the given root DM.
 * Authz: caller must be a participant in the conversation (the existing
 * `findConversationForParticipant` lookup enforces this — non-participants
 * receive 404 rather than 403 to match the rest of the DM surface).
 */
export async function POST(req: Request, { params }: RouteParams) {
  const { conversationId, messageId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const conversation = await dmMessageRepository.findConversationForParticipant(
    conversationId,
    userId
  );
  if (!conversation) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }

  const message = await dmMessageRepository.findActiveMessage({
    messageId,
    conversationId,
  });
  if (!message) {
    return NextResponse.json({ error: 'Message not found' }, { status: 404 });
  }
  if (message.parentId !== null) {
    return NextResponse.json(
      { error: 'parent_not_top_level' },
      { status: 400 }
    );
  }

  await dmMessageRepository.addDmThreadFollower(messageId, userId);

  auditRequest(req, {
    eventType: 'data.write',
    userId,
    resourceType: 'dm_thread_follower',
    resourceId: messageId,
  });

  return NextResponse.json({ following: true });
}

/**
 * DELETE /api/messages/[conversationId]/[messageId]/follow
 *
 * Removes the caller's DM follower row. Idempotent — deleting a non-existent
 * row is treated as success so rapid toggle does not race.
 */
export async function DELETE(req: Request, { params }: RouteParams) {
  const { conversationId, messageId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const conversation = await dmMessageRepository.findConversationForParticipant(
    conversationId,
    userId
  );
  if (!conversation) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }

  // DELETE intentionally uses the non-active variant so a tombstoned parent
  // still allows unfollow — without it, soft-deleting a thread root would
  // strand stale subscriptions that can never be cleared. We still scope the
  // lookup to (messageId, conversationId) so this route cannot be used to
  // probe for messages in other conversations.
  const message = await dmMessageRepository.findMessageInConversation({
    messageId,
    conversationId,
  });
  if (!message) {
    return NextResponse.json({ error: 'Message not found' }, { status: 404 });
  }

  await dmMessageRepository.removeDmThreadFollower(messageId, userId);

  auditRequest(req, {
    eventType: 'data.delete',
    userId,
    resourceType: 'dm_thread_follower',
    resourceId: messageId,
  });

  return NextResponse.json({ following: false });
}
