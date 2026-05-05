import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { channelMessageRepository } from '@pagespace/lib/services/channel-message-repository';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

type RouteParams = { params: Promise<{ pageId: string; messageId: string }> };

/**
 * POST /api/channels/[pageId]/messages/[messageId]/follow
 *
 * Idempotently subscribes the caller to thread updates for the given root
 * message. The repository upsert relies on a unique
 * (rootMessageId, userId) index, so a second POST is a no-op.
 *
 * Authz: caller must be able to view the channel (matches the read path).
 * Validation: the message must exist in this channel, be active, and itself
 * be a top-level message — followers attach to thread roots, not replies.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const { pageId, messageId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const canView = await canUserViewPage(userId, pageId);
  if (!canView) {
    return NextResponse.json(
      { error: 'You need view permission to follow threads in this channel' },
      { status: 403 }
    );
  }

  const message = await channelMessageRepository.findChannelMessageInPage({
    messageId,
    pageId,
  });

  if (!message || !message.isActive) {
    return NextResponse.json({ error: 'Message not found' }, { status: 404 });
  }
  if (message.parentId !== null) {
    return NextResponse.json(
      { error: 'parent_not_top_level' },
      { status: 400 }
    );
  }

  await channelMessageRepository.addChannelThreadFollower(messageId, userId);

  auditRequest(req, {
    eventType: 'data.write',
    userId,
    resourceType: 'channel_thread_follower',
    resourceId: messageId,
  });

  return NextResponse.json({ following: true });
}

/**
 * DELETE /api/channels/[pageId]/messages/[messageId]/follow
 *
 * Removes the caller's follower row. Idempotent — deleting a row that does not
 * exist is treated as success so clients do not need to track local state to
 * avoid 404s on rapid toggle.
 */
export async function DELETE(req: Request, { params }: RouteParams) {
  const { pageId, messageId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const canView = await canUserViewPage(userId, pageId);
  if (!canView) {
    return NextResponse.json(
      { error: 'You need view permission to manage thread follows' },
      { status: 403 }
    );
  }

  const message = await channelMessageRepository.findChannelMessageInPage({
    messageId,
    pageId,
  });

  if (!message) {
    return NextResponse.json({ error: 'Message not found' }, { status: 404 });
  }

  await channelMessageRepository.removeChannelThreadFollower(messageId, userId);

  auditRequest(req, {
    eventType: 'data.delete',
    userId,
    resourceType: 'channel_thread_follower',
    resourceId: messageId,
  });

  return NextResponse.json({ following: false });
}
