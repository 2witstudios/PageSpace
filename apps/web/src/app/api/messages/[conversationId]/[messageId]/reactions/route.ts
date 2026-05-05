import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { createSignedBroadcastHeaders } from '@pagespace/lib/auth/broadcast-auth';
import { dmMessageRepository } from '@pagespace/lib/services/dm-message-repository';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

// Bound the realtime fan-out so a stalled sidecar can't hang the user-facing
// HTTP response after the DB write has already committed.
const BROADCAST_TIMEOUT_MS = 1500;

type RouteParams = { params: Promise<{ conversationId: string; messageId: string }> };

async function broadcastDmEvent(requestBody: string): Promise<void> {
  if (!process.env.INTERNAL_REALTIME_URL) return;
  const response = await fetch(`${process.env.INTERNAL_REALTIME_URL}/api/broadcast`, {
    method: 'POST',
    headers: createSignedBroadcastHeaders(requestBody),
    body: requestBody,
    signal: AbortSignal.timeout(BROADCAST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Broadcast failed with status ${response.status}`);
  }
}

/**
 * POST /api/messages/[conversationId]/[messageId]/reactions
 * Add a reaction to a DM message. Authz: caller must be a participant.
 * Duplicate (messageId, userId, emoji) is rejected by the unique index, never
 * by application code. Soft-deleted messages cannot accept new reactions —
 * the route uses the active-only lookup so reaction visibility stays in sync
 * with `listActiveMessages`.
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

  const { emoji } = await req.json();

  if (!emoji || typeof emoji !== 'string') {
    return NextResponse.json({ error: 'Emoji is required' }, { status: 400 });
  }

  const message = await dmMessageRepository.findActiveMessage({
    messageId,
    conversationId,
  });

  if (!message) {
    return NextResponse.json({ error: 'Message not found' }, { status: 404 });
  }

  try {
    const reaction = await dmMessageRepository.addDmReaction({
      messageId,
      userId,
      emoji,
    });

    auditRequest(req, {
      eventType: 'data.write',
      userId,
      resourceType: 'reaction',
      resourceId: messageId,
    });

    const reactionWithUser = await dmMessageRepository.loadDmReactionWithUser(reaction.id);

    try {
      // Reactions on a thread reply broadcast on the SAME conversation room
      // (`dm:{conversationId}`) — not a thread-specific room. PR 4's
      // ThreadPanel will subscribe to the same room and pick up the event by
      // matching `messageId`. Don't split this into a separate room without
      // updating PR 4's panel subscription too.
      await broadcastDmEvent(JSON.stringify({
        channelId: `dm:${conversationId}`,
        event: 'reaction_added',
        payload: { messageId, reaction: reactionWithUser },
      }));
    } catch (error) {
      loggers.realtime.error('Failed to broadcast DM reaction:', error as Error);
    }

    return NextResponse.json(reactionWithUser, { status: 201 });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      return NextResponse.json(
        { error: 'Already reacted with this emoji' },
        { status: 409 }
      );
    }
    throw error;
  }
}

/**
 * DELETE /api/messages/[conversationId]/[messageId]/reactions
 * Remove a reaction from a DM message. Only the caller's own (messageId,
 * userId, emoji) row is removed.
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

  const { emoji } = await req.json();

  if (!emoji || typeof emoji !== 'string') {
    return NextResponse.json({ error: 'Emoji is required' }, { status: 400 });
  }

  const message = await dmMessageRepository.findActiveMessage({
    messageId,
    conversationId,
  });

  if (!message) {
    return NextResponse.json({ error: 'Message not found' }, { status: 404 });
  }

  const removed = await dmMessageRepository.removeDmReaction({
    messageId,
    userId,
    emoji,
  });

  if (removed === 0) {
    return NextResponse.json({ error: 'Reaction not found' }, { status: 404 });
  }

  auditRequest(req, {
    eventType: 'data.delete',
    userId,
    resourceType: 'reaction',
    resourceId: messageId,
  });

  try {
    await broadcastDmEvent(JSON.stringify({
      channelId: `dm:${conversationId}`,
      event: 'reaction_removed',
      payload: { messageId, emoji, userId },
    }));
  } catch (error) {
    loggers.realtime.error('Failed to broadcast DM reaction removal:', error as Error);
  }

  return NextResponse.json({ success: true });
}
